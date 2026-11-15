import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeBase64, ModelBuilder, type ModelStats } from '@forsee/prediction';
import { forEachLine, readWordList } from './files';
import { REPO_ROOT, SEED_DIR } from './seed';

/**
 * The shipped English model, built from the English sentences of Tatoeba
 * (https://tatoeba.org, CC BY 2.0 FR). It is written as a base64 module that
 * `loadEnglishModel()` (`@forsee/prediction/english`) imports, so it is part
 * of the app bundle. See `packages/prediction/data/en-tatoeba/README.md` for
 * the licence and the measurements.
 *
 * Preparation (`prepareTatoeba`), all deterministic:
 * 1. Sentences are NFC-normalised and de-duplicated on a loose key
 *    (lower-cased, punctuation other than `'` removed), so near-identical
 *    sentences do not land in both training and test text.
 * 2. Sentences are ordered by the SHA-1 of that key; the first `heldOut` are
 *    kept back for testing and never trained on.
 * 3. Tatoeba's contributors reuse a few stock names (Tom alone is in about one
 *    sentence in six). Training sentences naming one of `STOCK_NAMES` are
 *    kept only one time in `stockNameKeepOneIn`, so the names do not crowd
 *    out ordinary words, for example at the start of a sentence.
 */

export const TATOEBA_DIR = join(REPO_ROOT, 'packages/prediction/data/en-tatoeba');
export const TATOEBA_HELDOUT_PATH = join(TATOEBA_DIR, 'heldout.txt');
export const TATOEBA_MODULE_PATH = join(
  REPO_ROOT,
  'packages/prediction/src/en-tatoeba/model.generated.ts',
);

/** Where to get the input (the per-language export, bzip2-compressed TSV: id, lang, text). */
export const TATOEBA_ENGLISH_URL =
  'https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2';

/** Names Tatoeba's example sentences use far more than ordinary text does. */
export const STOCK_NAMES: readonly string[] = [
  'Tom',
  'Mary',
  'Sami',
  'Layla',
  'Rima',
  'Skura',
  'Ziri',
  'Yanni',
  'Mennad',
  'Baya',
];

export const TATOEBA_BUILD_OPTIONS = {
  locale: 'en',
  order: 3,
  maxVocab: 30_000,
  minNgramCount: 3,
  wordListWeight: 0.3,
  description:
    'Forsee English model: built from Tatoeba sentences (https://tatoeba.org), CC BY 2.0 FR',
} as const;

export interface TatoebaPrepareOptions {
  /** Sentences kept back for testing (default 2000). */
  readonly heldOut?: number;
  /** Keep one training sentence in this many that names a stock name (default 10; 1 keeps all). */
  readonly stockNameKeepOneIn?: number;
}

export interface TatoebaSplit {
  readonly train: string[];
  readonly heldOut: string[];
  /** Distinct sentences after de-duplication. */
  readonly unique: number;
  /** Training sentences left out by the stock-name rule. */
  readonly droppedForNames: number;
}

/** The text column of one line of a Tatoeba sentences export, or `null`. */
export function tatoebaSentence(line: string): string | null {
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const text = parts.slice(2).join('\t').normalize('NFC').trim();
  return text === '' ? null : text;
}

/** The de-duplication key: lower case, letters, digits, apostrophes and single spaces only. */
export function dedupeKey(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_' ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

const STOCK_NAME_PATTERN = new RegExp(`\\b(?:${STOCK_NAMES.join('|')})\\b`);

/** Whether `sentence` names one of `STOCK_NAMES`. */
export function namesStockName(sentence: string): boolean {
  return STOCK_NAME_PATTERN.test(sentence);
}

/** De-duplicates, splits and down-weights (see the module comment). */
export function prepareTatoeba(
  sentences: Iterable<string>,
  options: TatoebaPrepareOptions = {},
): TatoebaSplit {
  const heldOutCount = options.heldOut ?? 2000;
  const keepOneIn = Math.max(1, Math.floor(options.stockNameKeepOneIn ?? 10));
  const byHash = new Map<string, string>();
  for (const sentence of sentences) {
    const key = dedupeKey(sentence);
    if (key === '') continue;
    const hash = sha1(key);
    if (!byHash.has(hash)) byHash.set(hash, sentence);
  }
  const ordered = [...byHash.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const heldOut = ordered.slice(0, heldOutCount).map(([, s]) => s);
  const train: string[] = [];
  let droppedForNames = 0;
  for (const [hash, sentence] of ordered.slice(heldOutCount)) {
    // The key's hash decides, so the choice does not depend on input order.
    if (keepOneIn > 1 && namesStockName(sentence) && parseInt(hash.slice(-8), 16) % keepOneIn) {
      droppedForNames++;
      continue;
    }
    train.push(sentence);
  }
  return { train, heldOut, unique: ordered.length, droppedForNames };
}

/** Reads an uncompressed Tatoeba sentences export (TSV) into its sentences. */
export async function readTatoebaExport(path: string): Promise<string[]> {
  const out: string[] = [];
  await forEachLine([path], (line) => {
    const sentence = tatoebaSentence(line);
    if (sentence !== null) out.push(sentence);
  });
  return out;
}

/** Builds the model from prepared training sentences (with the seed word list as the unigram prior). */
export async function buildTatoebaModel(
  train: readonly string[],
): Promise<{ bytes: Uint8Array; stats: ModelStats }> {
  const wordList = await readWordList(join(SEED_DIR, 'vocabulary.txt'));
  const builder = new ModelBuilder({ ...TATOEBA_BUILD_OPTIONS, wordList });
  for (const sentence of train) builder.addVocabularyText(sentence);
  for (const sentence of train) builder.addText(sentence);
  const bytes = builder.build();
  return { bytes, stats: builder.stats() };
}

/** The TypeScript module embedding `bytes` (formatted the way Prettier would). */
export function renderEnglishModule(bytes: Uint8Array): string {
  return [
    '// Generated by tools/lm-build (`lm-build tatoeba`). Do not edit.',
    '// Built from Tatoeba sentences (https://tatoeba.org). Licence: CC BY 2.0 FR, not MIT;',
    '// see packages/prediction/data/en-tatoeba/README.md.',
    'export const ENGLISH_MODEL_BASE64 =',
    `  '${encodeBase64(bytes)}';`,
    '',
  ].join('\n');
}

/** What `writeTatoebaModel` did: build statistics and sentence counts. */
export interface TatoebaBuildSummary {
  readonly stats: ModelStats;
  readonly unique: number;
  readonly train: number;
  readonly heldOut: number;
  readonly droppedForNames: number;
}

/**
 * Prepares the export at `exportPath`, builds the model and writes the
 * checked-in model module and `heldout.txt`. With `binPath`, also writes the
 * plain model file (for `lm-build check`).
 */
export async function writeTatoebaModel(
  exportPath: string,
  binPath?: string,
): Promise<TatoebaBuildSummary> {
  const split = prepareTatoeba(await readTatoebaExport(exportPath));
  const { bytes, stats } = await buildTatoebaModel(split.train);
  await mkdir(TATOEBA_DIR, { recursive: true });
  await writeFile(TATOEBA_MODULE_PATH, renderEnglishModule(bytes));
  await writeFile(TATOEBA_HELDOUT_PATH, `${split.heldOut.join('\n')}\n`);
  if (binPath !== undefined) await writeFile(binPath, bytes);
  return {
    stats,
    unique: split.unique,
    train: split.train.length,
    heldOut: split.heldOut.length,
    droppedForNames: split.droppedForNames,
  };
}
