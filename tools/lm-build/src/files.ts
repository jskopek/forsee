import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ModelBuilder, type ModelBuildOptions, type ModelStats } from '@forsee/prediction';

/**
 * Node helpers around the pure `ModelBuilder`: list input files, stream them
 * line by line (twice: vocabulary pass, then n-gram pass), read word lists.
 * Memory use is bounded by the number of distinct n-grams, not the input size.
 */

/** Expands files and directories (recursively, `*.txt` only) into a sorted file list. */
export async function listInputFiles(paths: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const visit = async (path: string, explicit: boolean): Promise<void> => {
    const info = await stat(path);
    if (info.isDirectory()) {
      const entries = (await readdir(path)).sort();
      for (const name of entries) await visit(join(path, name), false);
    } else if (explicit || path.endsWith('.txt')) {
      out.push(path);
    }
  };
  for (const p of paths) await visit(p, true);
  return [...new Set(out)].sort();
}

/** Calls `onLine` for every line of every file, in order, streaming. */
export async function forEachLine(
  files: readonly string[],
  onLine: (line: string) => void,
): Promise<void> {
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of lines) onLine(line);
  }
}

/** Reads a word list: one word per line, blank lines and `#` comments ignored. */
export async function readWordList(path: string): Promise<string[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/** Builds a model from files, streaming over them twice. */
export async function buildFromFiles(
  files: readonly string[],
  options: ModelBuildOptions = {},
): Promise<{ bytes: Uint8Array; stats: ModelStats }> {
  const builder = new ModelBuilder(options);
  await forEachLine(files, (line) => builder.addVocabularyText(line));
  await forEachLine(files, (line) => builder.addText(line));
  const bytes = builder.build();
  return { bytes, stats: builder.stats() };
}

/** Human-readable summary of build statistics. */
export function formatStats(stats: ModelStats): string {
  const kb = (stats.bytes / 1024).toFixed(1);
  return [
    `vocabulary:     ${stats.vocabulary} words`,
    `sentences:      ${stats.sentences}`,
    `tokens:         ${stats.tokens}`,
    `unigrams:       ${stats.unigrams} (including <s>, </s>, <unk>)`,
    `bigrams:        ${stats.bigrams}`,
    `trigrams:       ${stats.trigrams}`,
    `char contexts:  ${stats.charContexts}`,
    `KN discounts:   ${stats.discounts.map((d) => d.toFixed(3)).join(', ')}`,
    `file size:      ${stats.bytes} bytes (${kb} KiB)`,
  ].join('\n');
}
