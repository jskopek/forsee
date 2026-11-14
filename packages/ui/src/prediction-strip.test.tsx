// @vitest-environment jsdom
import type {
  Candidate,
  PredictionProvider,
  PredictionRequest,
  PredictionResult,
} from '@forsee/plugin-api';
import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PredictionStrip, predictionTargetId } from './prediction-strip';
import { createTestHost, rectsByName, renderWithHost, type TestHost } from './testing';

let hosts: TestHost[] = [];
afterEach(() => {
  cleanup();
  for (const host of hosts) host.dispose();
  hosts = [];
});

const c = (text: string, score: number): Candidate => ({ text, score });

function result(
  request: PredictionRequest,
  stage: 'instant' | 'refined',
  completions: Candidate[],
  nextWords: Candidate[] = [],
): PredictionResult {
  return {
    requestId: request.requestId,
    providerId: 'test',
    stage,
    completions,
    nextWords,
    letters: {},
    phrases: [],
  };
}

/** A provider whose refinement the test releases by hand. */
function scriptedProvider() {
  let release: (() => void) | null = null;
  const provider: PredictionProvider = {
    id: 'test',
    capabilities: { kinds: ['completions', 'nextWords'], usesKeyDistributions: false },
    predict: (request) =>
      result(
        request,
        'instant',
        request.partialWord === ''
          ? []
          : [c('alpha', 0.4), c('beta', 0.3), c('gamma', 0.2), c('delta', 0.1)],
        request.partialWord === '' ? [c('the', 0.5), c('and', 0.3)] : [],
      ),
    refine: (request) =>
      new Promise((resolve) => {
        release = () =>
          resolve(
            result(request, 'refined', [
              c('delta', 0.4),
              c('gamma', 0.3),
              c('beta', 0.2),
              c('alpha', 0.1),
            ]),
          );
      }),
  };
  return { provider, release: () => release?.() };
}

function setup() {
  const scripted = scriptedProvider();
  const host = createTestHost({
    providers: [scripted.provider],
    measure: rectsByName({ predictions: { x: 0, y: 0, width: 800, height: 100 } }),
  });
  hosts.push(host);
  renderWithHost(<PredictionStrip />, { host });
  const words = (): string[] =>
    within(screen.getByRole('group', { name: 'Word predictions' }))
      .queryAllByRole('button')
      .map((b) => b.textContent ?? '');
  return { host, words, release: scripted.release };
}

describe('PredictionStrip', () => {
  it('shows next words with no partial word, completions while typing, in fixed slots', async () => {
    const { host, words } = setup();
    expect(words()).toEqual(['the', 'and']);
    // Empty slots are rest areas, not selectable targets.
    expect(host.registry.get('predictions/empty-2')?.role).toBe('rest');
    expect(host.registry.get('predictions/empty-3')?.role).toBe('rest');

    await act(() => host.kernel.commands.execute('composition.insert', { text: 'x' }));
    expect(words()).toEqual(['alpha', 'beta', 'gamma', 'delta']);
    const ids = host.registry
      .list()
      .filter((t) => t.id.startsWith('predictions/'))
      .map((t) => t.id);
    expect(ids).toEqual([0, 1, 2, 3].map((i) => predictionTargetId('predictions', i, words()[i]!)));
    expect(host.registry.get(predictionTargetId('predictions', 1, 'beta'))).toMatchObject({
      dwellClass: 'prediction',
      command: { command: 'composition.acceptPrediction', args: { text: 'beta' } },
    });
  });

  it('keeps the engaged candidate in its slot when a refined list reorders it', async () => {
    const { host, words, release } = setup();
    await act(() => host.kernel.commands.execute('composition.insert', { text: 'x' }));
    const beta = predictionTargetId('predictions', 1, 'beta');
    await host.dwellAt(host.centreOf(beta), 300);
    expect(screen.getByRole('button', { name: 'beta' }).dataset.engaged).toBe('true');

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await host.advance(0);
    expect(words()[1]).toBe('beta');
    expect(words()).toHaveLength(4);
    expect(new Set(words())).toEqual(new Set(['alpha', 'beta', 'gamma', 'delta']));
    expect(host.registry.get(beta)).toBeDefined();

    // Still the same target: dwelling on finishes the selection.
    await host.dwellAt(host.centreOf(beta), 900);
    expect(host.kernel.composition.text).toBe('beta ');
  });

  it('reorders freely when nothing is engaged', async () => {
    const { host, words, release } = setup();
    await act(() => host.kernel.commands.execute('composition.insert', { text: 'x' }));
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await host.advance(0);
    expect(words()).toEqual(['delta', 'gamma', 'beta', 'alpha']);
  });
});
