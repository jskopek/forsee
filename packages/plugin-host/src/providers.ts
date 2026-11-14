import { ForseeError } from '@forsee/core';
import type {
  Candidate,
  CancellationToken,
  ContextEntryInput,
  ForgetRequest,
  LearnEvent,
  OutputPayload,
  OutputSink,
  PermissionScope,
  PhraseCandidate,
  PredictionKind,
  PredictionProvider,
  PredictionProviderCapabilities,
  PredictionRequest,
  PredictionResult,
  TextTransform,
  TextTransformInput,
  TextTransformTrigger,
  Voice,
  VoiceProvider,
} from '@forsee/plugin-api';
import {
  copyJson,
  invalid,
  isPlainObject,
  LIMITS,
  optionalString,
  own,
  requireArray,
  requireBoolean,
  requireFunction,
  requireKey,
  requireNumber,
  requireObject,
  requireString,
  toCloneSafe,
} from './guards';
import { CONTEXT_KEY, LOCALE } from './patterns';

/**
 * Wrappers placed between the app and a plugin's logic contributions. Each
 * wrapper reads the contribution's data fields once (so a plugin cannot
 * change its id later), validates what the plugin returns before it reaches
 * an engine, and filters what the app sends according to the plugin's
 * permissions at the moment of the call.
 */

/** What a wrapper needs to know about its plugin at call time. */
export interface WrapperContext {
  readonly pluginId: string;
  /** Current permission, without prompting. */
  has(scope: PermissionScope): boolean;
  /** Throws `disposed` once the plugin is deactivated. */
  assertLive(): void;
}

const PREDICTION_KINDS: readonly PredictionKind[] = [
  'completions',
  'nextWords',
  'letters',
  'phrases',
];
const TRANSFORM_TRIGGERS: readonly TextTransformTrigger[] = ['word-boundary', 'commit'];

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

// ---------------------------------------------------------------- prediction

/** Validates a provider's capabilities. */
export function readCapabilities(value: unknown): PredictionProviderCapabilities {
  const caps = requireObject(value, 'capabilities');
  const kinds = requireArray(own(caps, 'kinds'), 'capabilities.kinds', 4);
  for (const kind of kinds) {
    if (!PREDICTION_KINDS.includes(kind as PredictionKind)) {
      invalid(`capabilities.kinds has an unknown kind ${JSON.stringify(kind)}`);
    }
  }
  return {
    kinds: [...new Set(kinds as PredictionKind[])],
    usesKeyDistributions: requireBoolean(
      own(caps, 'usesKeyDistributions'),
      'capabilities.usesKeyDistributions',
    ),
  };
}

/**
 * The request a plugin provider receives: a copy, with `conversation`
 * removed unless it holds `history.read` and `context` removed unless it
 * holds `context.read`.
 */
export function filterPredictionRequest(
  request: PredictionRequest,
  allow: { readonly history: boolean; readonly context: boolean },
): PredictionRequest {
  const copy = toCloneSafe(request) as Record<string, unknown>;
  if (!allow.history) delete copy.conversation;
  if (!allow.context) delete copy.context;
  return copy as unknown as PredictionRequest;
}

function clampScore(value: unknown, name: string): number {
  return Math.min(1, Math.max(0, requireNumber(value, name)));
}

function readCandidates(value: unknown, name: string, max: number): Candidate[] {
  const list = requireArray(value ?? [], name, LIMITS.candidates);
  return list.slice(0, max).map((item, i) => {
    const c = requireObject(item, `${name}[${i}]`);
    return {
      text: requireString(own(c, 'text'), `${name}[${i}].text`, { min: 1, max: 200 }),
      score: clampScore(own(c, 'score'), `${name}[${i}].score`),
    };
  });
}

function readPhrases(value: unknown, max: number): PhraseCandidate[] {
  const list = requireArray(value ?? [], 'phrases', LIMITS.candidates);
  return list.slice(0, max).map((item, i) => {
    const p = requireObject(item, `phrases[${i}]`);
    return {
      id: requireString(own(p, 'id'), `phrases[${i}].id`, { min: 1, max: 256 }),
      text: requireString(own(p, 'text'), `phrases[${i}].text`, { min: 1, max: 1000 }),
      score: clampScore(own(p, 'score'), `phrases[${i}].score`),
    };
  });
}

function readLetters(value: unknown): Readonly<Record<string, number>> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) invalid('letters must be an object');
  const keys = Object.keys(value);
  if (keys.length > 256) invalid('letters has too many entries');
  const out: Record<string, number> = {};
  for (const key of keys) {
    if (key.length === 0 || key.length > 16 || key === '__proto__')
      invalid('letters has an invalid key');
    out[key] = clampScore(value[key], `letters.${key}`);
  }
  return out;
}

/**
 * Validates a plugin's prediction result: forces `requestId`,
 * `providerId` and `stage`, caps lists at `maxCandidates`, clamps scores to
 * 0..1. Throws `invalid-argument` on a malformed result.
 */
export function sanitizePredictionResult(
  raw: unknown,
  request: PredictionRequest,
  providerId: string,
  stage: 'instant' | 'refined',
): PredictionResult {
  const result = requireObject(raw, 'prediction result');
  const max = Math.min(Math.max(0, Math.floor(request.maxCandidates)), LIMITS.candidates);
  return {
    requestId: request.requestId,
    providerId,
    stage,
    completions: readCandidates(own(result, 'completions'), 'completions', max),
    nextWords: readCandidates(own(result, 'nextWords'), 'nextWords', max),
    letters: readLetters(own(result, 'letters')),
    phrases: readPhrases(own(result, 'phrases'), max),
  };
}

/** Wraps a plugin's prediction provider (see `RegisterApi.predictionProvider`). */
export function wrapPredictionProvider(
  raw: unknown,
  id: string,
  ctx: WrapperContext,
): PredictionProvider {
  const provider = requireObject(raw, 'provider');
  const capabilities = readCapabilities(provider.capabilities);
  const predict = requireFunction(provider.predict, 'provider.predict');
  const refine =
    provider.refine === undefined ? undefined : requireFunction(provider.refine, 'provider.refine');
  const learn =
    provider.learn === undefined ? undefined : requireFunction(provider.learn, 'provider.learn');
  const forget =
    provider.forget === undefined ? undefined : requireFunction(provider.forget, 'provider.forget');
  const filter = (request: PredictionRequest): PredictionRequest =>
    filterPredictionRequest(request, {
      history: ctx.has('history.read'),
      context: ctx.has('context.read'),
    });
  const wrapped: PredictionProvider = {
    id,
    capabilities,
    predict(request) {
      ctx.assertLive();
      const answer: unknown = predict.call(provider, filter(request));
      if (isThenable(answer)) {
        return Promise.resolve(answer).then((r) =>
          sanitizePredictionResult(r, request, id, 'instant'),
        );
      }
      return sanitizePredictionResult(answer, request, id, 'instant');
    },
    ...(refine
      ? {
          async refine(request: PredictionRequest, cancellation: CancellationToken) {
            ctx.assertLive();
            const answer = await refine.call(provider, filter(request), cancellation);
            if (answer === null || answer === undefined) return null;
            return sanitizePredictionResult(answer, request, id, 'refined');
          },
        }
      : {}),
    ...(learn
      ? {
          async learn(event: LearnEvent) {
            ctx.assertLive();
            if (!ctx.has('lm.write')) return;
            await learn.call(provider, toCloneSafe(event));
          },
        }
      : {}),
    ...(forget
      ? {
          async forget(request: ForgetRequest) {
            ctx.assertLive();
            if (!ctx.has('lm.write')) return;
            await forget.call(provider, toCloneSafe(request));
          },
        }
      : {}),
  };
  return wrapped;
}

// ---------------------------------------------------------------- context

/** Validates one context entry a plugin supplies. */
export function readContextEntryInput(value: unknown, name = 'entry'): ContextEntryInput {
  const entry = requireObject(value, name);
  const key = requireKey(own(entry, 'key'), `${name}.key`);
  if (!CONTEXT_KEY.test(key)) invalid(`${name}.key must be dot-separated [A-Za-z0-9_-] segments`);
  const ttlMs = own(entry, 'ttlMs');
  const confidence = own(entry, 'confidence');
  return {
    key,
    value: copyJson(own(entry, 'value'), `${name}.value`),
    ...(ttlMs === undefined
      ? {}
      : { ttlMs: requireNumber(ttlMs, `${name}.ttlMs`, { min: 1, max: 365 * 24 * 3600 * 1000 }) }),
    ...(confidence === undefined
      ? {}
      : { confidence: requireNumber(confidence, `${name}.confidence`, { min: 0, max: 1 }) }),
  };
}

// ---------------------------------------------------------------- text transforms

/** Wraps a plugin's text transform: validates triggers and output. */
export function wrapTextTransform(raw: unknown, id: string, ctx: WrapperContext): TextTransform {
  const transform = requireObject(raw, 'transform');
  const name = requireString(transform.name, 'transform.name', {
    min: 1,
    max: LIMITS.labelLength,
  });
  const triggers = requireArray(transform.triggers, 'transform.triggers', 2);
  for (const trigger of triggers) {
    if (!TRANSFORM_TRIGGERS.includes(trigger as TextTransformTrigger)) {
      invalid(`transform.triggers has an unknown trigger ${JSON.stringify(trigger)}`);
    }
  }
  const fn = requireFunction(transform.transform, 'transform.transform');
  return {
    id,
    name,
    triggers: [...new Set(triggers as TextTransformTrigger[])],
    async transform(input: TextTransformInput) {
      ctx.assertLive();
      if (!ctx.has('composition.write')) return null;
      const out = await fn.call(transform, { ...input });
      if (out === null) return null;
      return requireString(out, 'transform result', { max: LIMITS.textLength });
    },
  };
}

// ---------------------------------------------------------------- voices

function readVoices(value: unknown, providerId: string): Voice[] {
  const list = requireArray(value, 'voices', 1000);
  return list.map((item, i) => {
    const v = requireObject(item, `voices[${i}]`);
    const isDefault = own(v, 'isDefault');
    return {
      id: requireKey(own(v, 'id'), `voices[${i}].id`, LIMITS.localIdLength),
      providerId,
      name: requireString(own(v, 'name'), `voices[${i}].name`, { min: 1, max: LIMITS.labelLength }),
      locale: requireString(own(v, 'locale'), `voices[${i}].locale`, { max: 35, pattern: LOCALE }),
      local: requireBoolean(own(v, 'local'), `voices[${i}].local`),
      ...(isDefault === undefined
        ? {}
        : { isDefault: requireBoolean(isDefault, `voices[${i}].isDefault`) }),
    };
  });
}

/** Wraps a plugin's voice provider: fixed id, validated voice lists. */
export function wrapVoiceProvider(raw: unknown, id: string, ctx: WrapperContext): VoiceProvider {
  const provider = requireObject(raw, 'provider');
  const listVoices = requireFunction(provider.listVoices, 'provider.listVoices');
  const speak = requireFunction(provider.speak, 'provider.speak');
  const stop = requireFunction(provider.stop, 'provider.stop');
  return {
    id,
    async listVoices() {
      ctx.assertLive();
      return readVoices(await listVoices.call(provider), id);
    },
    speak(utterance, events) {
      ctx.assertLive();
      if (!ctx.has('speech.output')) {
        throw new ForseeError('permission-denied', `${ctx.pluginId} no longer holds speech.output`);
      }
      return speak.call(provider, toCloneSafe(utterance), events) as ReturnType<
        VoiceProvider['speak']
      >;
    },
    stop() {
      stop.call(provider);
    },
  };
}

// ---------------------------------------------------------------- output sinks

/** Wraps a plugin's output sink. */
export function wrapOutputSink(raw: unknown, id: string, ctx: WrapperContext): OutputSink {
  const sink = requireObject(raw, 'sink');
  const name = requireString(sink.name, 'sink.name', {
    min: 1,
    max: LIMITS.labelLength,
  });
  const description = optionalString(sink.description, 'sink.description');
  const send = requireFunction(sink.send, 'sink.send');
  return {
    id,
    name,
    ...(description === undefined ? {} : { description }),
    async send(payload: OutputPayload) {
      ctx.assertLive();
      if (!ctx.has('composition.read')) {
        throw new ForseeError(
          'permission-denied',
          `${ctx.pluginId} no longer holds composition.read`,
        );
      }
      await send.call(sink, toCloneSafe(payload));
    },
  };
}
