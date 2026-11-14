import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeClock } from '@forsee/core';
import {
  createNgramProvider,
  createUserModel,
  loadLanguageModel,
  seedModelBytes,
} from '@forsee/prediction';
import { describe, expect, it } from 'vitest';
import { keystrokeSavings } from './evaluate';
import { buildSeedModel, readCheckedInSeed, renderSeedModule, SEED_DIR } from './seed';

describe('seed model', () => {
  it('is up to date with the seed text and deterministic', async () => {
    const { bytes, stats } = await buildSeedModel();
    const again = await buildSeedModel();
    expect(again.bytes).toEqual(bytes);
    const checkedIn = await readCheckedInSeed();
    // If this fails, run `pnpm --filter @forsee/lm-build seed`.
    expect(checkedIn.bin).toEqual(bytes);
    expect(checkedIn.module).toBe(renderSeedModule(bytes));
    expect(seedModelBytes()).toEqual(bytes);
    expect(stats.vocabulary).toBeGreaterThan(2000);
    expect(stats.sentences).toBeGreaterThan(500);
  });

  it('passes the keystroke-savings self-check on held-out sentences', async () => {
    const heldOut = (await readFile(join(SEED_DIR, 'heldout.txt'), 'utf8'))
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '');
    const corpus = await readFile(join(SEED_DIR, 'corpus.txt'), 'utf8');
    for (const sentence of heldOut) expect(corpus.includes(sentence)).toBe(false);
    const provider = createNgramProvider({
      base: loadLanguageModel(seedModelBytes()),
      user: createUserModel({ clock: new FakeClock() }),
    });
    const result = keystrokeSavings(provider, heldOut, {
      maxCandidates: 3,
      now: () => performance.now(),
    });
    console.log(
      `[seed self-check] ${result.words} words, keystroke savings ${(result.savings * 100).toFixed(1)}% ` +
        `(top 3; ${result.keystrokesWith} vs ${result.keystrokesWithout} keystrokes); predict p50 ` +
        `${result.latencyMs.p50.toFixed(3)} ms, p95 ${result.latencyMs.p95.toFixed(3)} ms`,
    );
    // Tiny in-domain seed data: a sanity floor, not a quality claim.
    expect(result.savings).toBeGreaterThan(0.4);
  });
});
