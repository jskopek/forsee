import { ExtensionRegistry, FakeClock, ForseeError } from '@forsee/core';
import type {
  CancellationToken,
  Candidate,
  LearnEvent,
  PredictionProvider,
  PredictionRequest,
  PredictionResult,
} from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import type { PredictionQuery } from './contracts';
import { createPredictionEngine, stabiliseCandidates } from './engine';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const c = (text: string, score: number): Candidate => ({ text, score });

function result(
  request: PredictionRequest,
  providerId: string,
  completions: Candidate[],
  extra: Partial<PredictionResult> = {},
): PredictionResult {
  return {
    requestId: request.requestId,
    providerId,
    stage: 'instant',
    completions,
    nextWords: [],
    letters: {},
    phrases: [],
    ...extra,
  };
}

function provider(
  id: string,
  predict: PredictionProvider['predict'],
  extra: Partial<PredictionProvider> = {},
): PredictionProvider {
  return {
    id,
    capabilities: {
      kinds: ['completions', 'nextWords', 'letters', 'phrases'],
      usesKeyDistributions: false,
    },
    predict,
    ...extra,
  };
}

const query = (partialWord: string, extra: Partial<PredictionQuery> = {}): PredictionQuery => ({
  textBefore: partialWord,
  partialWord,
  locale: 'en',
  maxCandidates: 3,
  kinds: ['completions', 'letters'],
  ...extra,
});

function setup(options: { weights?: Record<string, number> } = {}) {
  const extensions = new ExtensionRegistry();
  const clock = new FakeClock();
  const errors: [unknown, string][] = [];
  const engine = createPredictionEngine({
    extensions,
    clock,
    reportError: (error, context) => errors.push([error, context]),
    ...(options.weights ? { weights: options.weights } : {}),
  });
  return { extensions, clock, errors, engine };
}

describe('stabiliseCandidates', () => {
  const prev = [c('a', 0.5), c('b', 0.3), c('c', 0.2)];
  it('keeps the pinned candidate in its slot', () => {
    const next = [c('c', 0.6), c('d', 0.3), c('b', 0.1)];
    expect(stabiliseCandidates(prev, next, 'b').map((x) => x.text)).toEqual(['c', 'b', 'd']);
    expect(stabiliseCandidates(prev, next, null)).toBe(next);
    expect(stabiliseCandidates(prev, next, 'zzz')).toBe(next);
  });
  it('keeps a pinned candidate that disappeared, without growing the list', () => {
    const next = [c('x', 0.6), c('y', 0.3), c('z', 0.1)];
    expect(stabiliseCandidates(prev, next, 'b').map((x) => x.text)).toEqual(['x', 'b', 'y']);
    expect(stabiliseCandidates(prev, [c('x', 1)], 'c').map((x) => x.text)).toEqual(['x', 'c']);
  });
});

describe('prediction engine', () => {
  it('issues strictly increasing request ids and merges instant results', () => {
    const { extensions, engine } = setup({ weights: { two: 3 } });
    const seen: number[] = [];
    extensions.register(
      'predictionProviders',
      'app',
      provider('one', (r) => {
        seen.push(r.requestId);
        return result(r, 'one', [c('hello', 0.6), c('help', 0.4)], { letters: { l: 0.5, p: 0.5 } });
      }),
    );
    extensions.register(
      'predictionProviders',
      'app',
      provider('two', (r) =>
        result(r, 'two', [c('Help', 0.8), c('helmet', 0.1)], { letters: { l: 1 } }),
      ),
    );
    const s1 = engine.predict(query('hel'));
    const s2 = engine.predict(query('hel'));
    expect([s1.requestId, s2.requestId]).toEqual([1, 2]);
    expect(seen).toEqual([1, 2]);
    const r = s2.instant;
    expect(r.requestId).toBe(2);
    expect(r.providerId).toBe('forsee.engine');
    // help: (0.4·1 + 0.8·3) / 4 = 0.7; hello: 0.6/4 = 0.15; helmet: 0.3/4 = 0.075.
    expect(r.completions.map((x) => x.text)).toEqual(['Help', 'hello', 'helmet']);
    expect(r.completions[0]?.score).toBeCloseTo(0.7, 9);
    expect(r.letters.l).toBeCloseTo((0.5 + 3) / 4, 9);
    expect(Object.values(r.letters).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1);
  });

  it('skips providers that cannot answer the requested kinds', () => {
    const { extensions, engine } = setup();
    let called = false;
    extensions.register('predictionProviders', 'app', {
      ...provider('phr', (r) => {
        called = true;
        return result(r, 'phr', []);
      }),
      capabilities: { kinds: ['phrases'], usesKeyDistributions: false },
    });
    engine.predict(query('a'));
    expect(called).toBe(false);
  });

  it('isolates and reports providers that throw', () => {
    const { extensions, engine, errors } = setup();
    extensions.register(
      'predictionProviders',
      'app',
      provider('bad', () => {
        throw new Error('boom');
      }),
    );
    extensions.register(
      'predictionProviders',
      'app',
      provider('good', (r) => result(r, 'good', [c('ok', 1)])),
    );
    const s = engine.predict(query('o'));
    expect(s.instant.completions.map((x) => x.text)).toEqual(['ok']);
    expect(errors.map(([, ctx]) => ctx)).toEqual(['prediction.predict:bad']);
  });

  it('delivers async instant answers as updates and drops stale ones', async () => {
    const { extensions, engine } = setup();
    const pending: [PredictionRequest, (r: PredictionResult) => void][] = [];
    extensions.register(
      'predictionProviders',
      'app',
      provider(
        'remote',
        (r) => new Promise<PredictionResult>((resolve) => pending.push([r, resolve])),
      ),
    );
    const s1 = engine.predict(query('a'));
    const updates1: PredictionResult[] = [];
    s1.onUpdate((r) => updates1.push(r));
    expect(s1.instant.completions).toEqual([]);
    const s2 = engine.predict(query('ab'));
    const updates2: PredictionResult[] = [];
    s2.onUpdate((r) => updates2.push(r));
    // The older request answers late: dropped.
    pending[0]![1](result(pending[0]![0], 'remote', [c('apple', 1)]));
    pending[1]![1](result(pending[1]![0], 'remote', [c('about', 1)]));
    await flush();
    expect(updates1).toEqual([]);
    expect(updates2.map((r) => r.completions.map((x) => x.text))).toEqual([['about']]);
  });

  it('ignores results that carry the wrong request id', async () => {
    const { extensions, engine } = setup();
    extensions.register(
      'predictionProviders',
      'app',
      provider('liar', (r) =>
        Promise.resolve(result({ ...r, requestId: 999 }, 'liar', [c('x', 1)])),
      ),
    );
    const s = engine.predict(query('x'));
    const updates: PredictionResult[] = [];
    s.onUpdate((r) => updates.push(r));
    await flush();
    expect(updates).toEqual([]);
  });

  it('refines, cancels refinements of superseded requests, and keeps the pinned candidate in place', async () => {
    const { extensions, engine } = setup();
    const tokens: CancellationToken[] = [];
    const resolvers: ((r: PredictionResult | null) => void)[] = [];
    const requests: PredictionRequest[] = [];
    extensions.register(
      'predictionProviders',
      'app',
      provider(
        'neural',
        (r) => result(r, 'neural', [c('hello', 0.5), c('help', 0.3), c('hold', 0.2)]),
        {
          refine: (r, token) => {
            tokens.push(token);
            requests.push(r);
            return new Promise((resolve) => resolvers.push(resolve));
          },
        },
      ),
    );
    const s1 = engine.predict(query('h'));
    expect(tokens[0]?.cancelled).toBe(false);
    const s2 = engine.predict(query('he'));
    expect(tokens[0]?.cancelled).toBe(true);
    expect(tokens[1]?.cancelled).toBe(false);
    const updates: PredictionResult[] = [];
    s1.onUpdate(() => updates.push(s1.instant));
    s2.onUpdate((r) => updates.push(r));
    s2.pin('help');
    resolvers[0]!(result(requests[0]!, 'neural', [c('stale', 1)], { stage: 'refined' }));
    resolvers[1]!(
      result(requests[1]!, 'neural', [c('help', 0.6), c('helmet', 0.3), c('hello', 0.1)], {
        stage: 'refined',
      }),
    );
    await flush();
    expect(updates).toHaveLength(1);
    expect(updates[0]?.stage).toBe('refined');
    // `help` was at index 1 in the instant list and stays there.
    expect(updates[0]?.completions.map((x) => x.text)).toEqual(['helmet', 'help', 'hello']);
  });

  it('times out slow refinements and reports them', async () => {
    const { extensions, engine, clock, errors } = setup();
    let token: CancellationToken | null = null;
    extensions.register(
      'predictionProviders',
      'app',
      provider('slow', (r) => result(r, 'slow', [c('a', 1)]), {
        refine: (_r, t) => {
          token = t;
          return new Promise(() => undefined);
        },
      }),
    );
    const s = engine.predict(query('a'));
    const updates: PredictionResult[] = [];
    s.onUpdate((r) => updates.push(r));
    clock.advance(1000);
    await flush();
    expect((token as CancellationToken | null)?.cancelled).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toBeInstanceOf(ForseeError);
    expect((errors[0]?.[0] as ForseeError).code).toBe('timeout');
    expect(updates).toEqual([]);
  });

  it('reports rejected refinements except cancellations', async () => {
    const { extensions, engine, errors } = setup();
    let mode = 'fail';
    extensions.register(
      'predictionProviders',
      'app',
      provider('r', (r) => result(r, 'r', []), {
        refine: () =>
          Promise.reject(
            mode === 'fail' ? new Error('nope') : new ForseeError('cancelled', 'stop'),
          ),
      }),
    );
    engine.predict(query('a'));
    await flush();
    mode = 'cancel';
    engine.predict(query('b'));
    await flush();
    expect(errors.map(([, ctx]) => ctx)).toEqual(['prediction.refine:r']);
  });

  it('passes conversation and context only to providers allowed to see them', () => {
    const extensions = new ExtensionRegistry();
    const got: Record<string, PredictionRequest> = {};
    const spy = (id: string) => provider(id, (r) => ((got[id] = r), result(r, id, [])));
    extensions.register('predictionProviders', 'app', spy('builtin'));
    extensions.register('predictionProviders', 'community.plugin', spy('community.plugin/p'));
    extensions.register('predictionProviders', 'trusted.plugin', spy('trusted.plugin/p'));
    const conversation = { recent: [{ sender: 'contact' as const, body: 'Tea?', createdAt: 1 }] };
    const context = [{ key: 'time.partOfDay', value: 'evening', source: 'app', updatedAt: 1 }];
    const defaults = createPredictionEngine({ extensions, context: () => context });
    defaults.predict(query('a', { conversation }));
    expect(got.builtin?.conversation).toEqual(conversation);
    expect(got.builtin?.context).toEqual(context);
    expect(got['community.plugin/p']).not.toHaveProperty('conversation');
    expect(got['community.plugin/p']).not.toHaveProperty('context');
    const hooked = createPredictionEngine({
      extensions,
      context: () => context,
      access: (contribution) => ({
        conversation: contribution.owner === 'trusted.plugin',
        context: false,
        learn: contribution.owner !== 'community.plugin',
      }),
    });
    hooked.predict(query('a', { conversation }));
    expect(got['trusted.plugin/p']?.conversation).toEqual(conversation);
    expect(got['trusted.plugin/p']).not.toHaveProperty('context');
    expect(got.builtin).not.toHaveProperty('conversation');
  });

  it('forwards learn and forget to allowed providers, isolating failures', async () => {
    const { extensions, engine, errors } = setup();
    const events: string[] = [];
    extensions.register(
      'predictionProviders',
      'app',
      provider('a', (r) => result(r, 'a', []), {
        learn: (e: LearnEvent) => void events.push(`a:${e.text}`),
        forget: () => void events.push('a:forget'),
      }),
    );
    extensions.register(
      'predictionProviders',
      'app',
      provider('b', (r) => result(r, 'b', []), {
        learn: () => Promise.reject(new Error('disk full')),
      }),
    );
    extensions.register(
      'predictionProviders',
      'some.plugin',
      provider('some.plugin/c', (r) => result(r, 'c', []), {
        learn: () => void events.push('c:learn'),
      }),
    );
    await engine.learn({ text: 'hi', origin: 'composition', locale: 'en', createdAt: 0 });
    await engine.forget({ kind: 'all' });
    expect(events).toEqual(['a:hi', 'a:forget']);
    expect(errors.map(([, ctx]) => ctx)).toEqual(['prediction.learn:b']);
  });

  it('stops after dispose', () => {
    const { extensions, engine } = setup();
    let calls = 0;
    extensions.register(
      'predictionProviders',
      'app',
      provider('p', (r) => (calls++, result(r, 'p', []))),
    );
    engine.dispose();
    const s = engine.predict(query('a'));
    expect(calls).toBe(0);
    expect(s.instant.completions).toEqual([]);
  });
});
