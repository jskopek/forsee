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
  SpeechEndReason,
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
import type { PermissionManager } from './contracts';
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

/**
 * What one prediction provider may see and do: structurally the
 * `ProviderAccess` of `@forsee/prediction` (this package does not depend on
 * it), returned by `predictionAccess`.
 */
export interface PredictionProviderAccess {
  readonly conversation: boolean;
  readonly context: boolean;
  readonly learn: boolean;
}

const APP_PREDICTION_ACCESS: PredictionProviderAccess = {
  conversation: true,
  context: true,
  learn: true,
};

/**
 * The prediction engine's `access` hook (`PredictionEngineOptions.access`),
 * decided from the plugin host's permission manager, so the engine and the
 * provider wrapper apply the same rules: a provider owned by the app gets
 * everything; a plugin's provider gets `conversation` with `history.read`,
 * `context` with `context.read`, and `learn`/`forget` with `lm.write` (and
 * `composition.read`, which every call needs). Pass it as
 * `createPredictionEngine({ access: predictionAccess(pluginHost.permissions) })`.
 *
 * Without it the engine's default denies every plugin-owned provider
 * `learn`, so a first-party predictor registered through the plugin API
 * would never learn the user's words, whatever its permissions.
 */
export function predictionAccess(
  permissions: Pick<PermissionManager, 'has'>,
): (contribution: { readonly owner: string }) => PredictionProviderAccess {
  return ({ owner }) => {
    if (owner === 'app') return APP_PREDICTION_ACCESS;
    const read = permissions.has(owner, 'composition.read');
    return {
      conversation: read && permissions.has(owner, 'history.read'),
      context: read && permissions.has(owner, 'context.read'),
      learn: read && permissions.has(owner, 'lm.write'),
    };
  };
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

/** An empty result for `request`, given when a provider may not see it. */
export function emptyPredictionResult(
  request: PredictionRequest,
  providerId: string,
  stage: 'instant' | 'refined',
): PredictionResult {
  return {
    requestId: request.requestId,
    providerId,
    stage,
    completions: [],
    nextWords: [],
    letters: {},
    phrases: [],
  };
}

/**
 * Wraps a plugin's prediction provider (see `RegisterApi.predictionProvider`).
 * Every call checks the plugin's permissions at that moment: without
 * `composition.read` the plugin is not called at all (`predict` answers an
 * empty result, `refine` null, `learn`/`forget` nothing); `conversation`
 * needs `history.read`, `context` needs `context.read`, and `learn`/`forget`
 * also need `lm.write`.
 */
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
  // Every request carries the composition, so nothing reaches the plugin
  // unless it holds `composition.read` at the moment of the call.
  const mayRead = (): boolean => ctx.has('composition.read');
  const wrapped: PredictionProvider = {
    id,
    capabilities,
    predict(request) {
      ctx.assertLive();
      if (!mayRead()) return emptyPredictionResult(request, id, 'instant');
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
            if (!mayRead()) return null;
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
            if (!mayRead() || !ctx.has('lm.write')) return;
            await learn.call(provider, toCloneSafe(event));
          },
        }
      : {}),
    ...(forget
      ? {
          async forget(request: ForgetRequest) {
            ctx.assertLive();
            if (!mayRead() || !ctx.has('lm.write')) return;
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

/**
 * Wraps a plugin's text transform: validates triggers and output. A
 * transform sees the composition and can change it, so it is called only
 * while the plugin holds both `composition.read` and `composition.write`.
 */
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
      if (!ctx.has('composition.read') || !ctx.has('composition.write')) return null;
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

const END_REASONS: readonly SpeechEndReason[] = ['completed', 'stopped', 'error'];

/** Scopes a voice provider needs at the moment it is given an utterance. */
export const VOICE_PROVIDER_SCOPES: readonly PermissionScope[] = [
  'speech.output',
  'composition.read',
];

/**
 * Wraps a plugin's voice provider: fixed id, validated voice lists, a
 * validated handle. Utterances are what the user composed, so `speak` is
 * delivered only while the plugin holds `speech.output` and
 * `composition.read`; otherwise it throws `permission-denied` (the speech
 * queue ends that utterance with `error`) without calling the plugin.
 */
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
      for (const scope of VOICE_PROVIDER_SCOPES) {
        if (!ctx.has(scope)) {
          throw new ForseeError('permission-denied', `${ctx.pluginId} does not hold ${scope}`);
        }
      }
      const handle = requireObject(
        speak.call(provider, toCloneSafe(utterance), events),
        'speech handle',
      );
      const handleStop = requireFunction(handle.stop, 'speech handle.stop');
      const done: unknown = handle.done;
      if (!isThenable(done)) invalid('speech handle.done must be a promise');
      return {
        utteranceId: utterance.id,
        stop: () => {
          handleStop.call(handle);
        },
        done: Promise.resolve(done).then(
          (reason) => (END_REASONS.includes(reason as SpeechEndReason) ? reason : 'error'),
          () => 'error',
        ) as Promise<SpeechEndReason>,
      };
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
