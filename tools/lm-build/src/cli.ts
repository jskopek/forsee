import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { FakeClock } from '@forsee/core';
import { createNgramProvider, createUserModel, loadLanguageModel } from '@forsee/prediction';
import { keystrokeSavings } from './evaluate';
import { buildFromFiles, formatStats, listInputFiles, readWordList } from './files';
import { writeSeedModel } from './seed';
import { TATOEBA_ENGLISH_URL, writeTatoebaModel } from './tatoeba';

const USAGE = `Usage:
  lm-build --input <file|dir> [--input …] --out model.bin [options]
  lm-build seed                       rebuild the seed model from packages/prediction/data/seed
  lm-build tatoeba --sentences eng_sentences.tsv [--bin model.bin]
                                      rebuild the shipped English model from a Tatoeba export
  lm-build check --model model.bin --text heldout.txt [--candidates 3]

Build options:
  --input, -i <path>       text file or directory (*.txt, recursive); repeatable; positional paths work too
  --out, -o <path>         output model file
  --order <1-3>            word n-gram order (default 3)
  --max-vocab <n>          vocabulary size limit (default 50000)
  --min-count <n>          minimum word count for the vocabulary (default 1)
  --min-ngram-count <n>    prune bigrams and trigrams seen fewer times (default 1)
  --word-list <path>       word list in frequency order, one per line (always in the vocabulary)
  --word-list-weight <x>   weight of the word-list prior, 0..1 (default 0.3)
  --locale <tag>           locale (default en)
  --description <text>     stored in the model metadata
  --stats                  print a summary
`;

function int(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
}

async function build(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      input: { type: 'string', short: 'i', multiple: true },
      out: { type: 'string', short: 'o' },
      order: { type: 'string' },
      'max-vocab': { type: 'string' },
      'min-count': { type: 'string' },
      'min-ngram-count': { type: 'string' },
      'word-list': { type: 'string' },
      'word-list-weight': { type: 'string' },
      locale: { type: 'string' },
      description: { type: 'string' },
      stats: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const inputs = [...(values.input ?? []), ...positionals];
  if (inputs.length === 0 || values.out === undefined)
    throw new Error('--input and --out are required');
  const files = await listInputFiles(inputs);
  if (files.length === 0) throw new Error('No input files found');
  const wordList =
    values['word-list'] === undefined ? undefined : await readWordList(values['word-list']);
  const order = int(values.order, 'order');
  const maxVocab = int(values['max-vocab'], 'max-vocab');
  const minCount = int(values['min-count'], 'min-count');
  const minNgramCount = int(values['min-ngram-count'], 'min-ngram-count');
  const wordListWeight = int(values['word-list-weight'], 'word-list-weight');
  const { bytes, stats } = await buildFromFiles(files, {
    ...(order === undefined ? {} : { order }),
    ...(maxVocab === undefined ? {} : { maxVocab }),
    ...(minCount === undefined ? {} : { minCount }),
    ...(minNgramCount === undefined ? {} : { minNgramCount }),
    ...(wordList === undefined ? {} : { wordList }),
    ...(wordListWeight === undefined ? {} : { wordListWeight }),
    ...(values.locale === undefined ? {} : { locale: values.locale }),
    ...(values.description === undefined ? {} : { description: values.description }),
  });
  await writeFile(values.out, bytes);
  if (values.stats) process.stdout.write(`${formatStats(stats)}\n`);
  else process.stdout.write(`Wrote ${values.out} (${bytes.length} bytes)\n`);
}

async function evaluate(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      model: { type: 'string' },
      text: { type: 'string' },
      candidates: { type: 'string' },
    },
  });
  if (values.model === undefined || values.text === undefined)
    throw new Error('--model and --text are required');
  const base = loadLanguageModel(new Uint8Array(await readFile(values.model)));
  const provider = createNgramProvider({ base, user: createUserModel({ clock: new FakeClock() }) });
  const sentences = (await readFile(values.text, 'utf8'))
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  const result = keystrokeSavings(provider, sentences, {
    maxCandidates: int(values.candidates, 'candidates') ?? 3,
    now: () => performance.now(),
  });
  const l = result.latencyMs;
  process.stdout.write(
    [
      `sentences: ${result.sentences}, words: ${result.words}`,
      `keystrokes: ${result.keystrokesWith} with prediction, ${result.keystrokesWithout} without`,
      `keystroke savings: ${(result.savings * 100).toFixed(1)}%`,
      `predict latency (ms): mean ${l.mean.toFixed(4)}, p50 ${l.p50.toFixed(4)}, p95 ${l.p95.toFixed(4)}, max ${l.max.toFixed(4)} over ${l.count} calls`,
      '',
    ].join('\n'),
  );
}

async function tatoeba(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { sentences: { type: 'string' }, bin: { type: 'string' } },
  });
  if (values.sentences === undefined)
    throw new Error(`--sentences is required (the unpacked ${TATOEBA_ENGLISH_URL})`);
  const summary = await writeTatoebaModel(values.sentences, values.bin);
  process.stdout.write(
    [
      'English model rebuilt (packages/prediction/src/en-tatoeba, data/en-tatoeba/heldout.txt).',
      `sentences:      ${summary.unique} distinct, ${summary.heldOut} held out, ${summary.train} trained on (${summary.droppedForNames} left out for stock names)`,
      formatStats(summary.stats),
      '',
    ].join('\n'),
  );
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === 'seed') {
    const stats = await writeSeedModel();
    process.stdout.write(`Seed model rebuilt.\n${formatStats(stats)}\n`);
  } else if (command === 'tatoeba') {
    await tatoeba(rest);
  } else if (command === 'check') {
    await evaluate(rest);
  } else if (command === 'build') {
    await build(rest);
  } else {
    await build(argv);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `lm-build: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
  );
  process.exitCode = 1;
});
