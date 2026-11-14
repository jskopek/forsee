import type { Voice } from '@forsee/plugin-api';

/** The global id of a voice: `<providerId>/<voiceId>`. */
export function globalVoiceId(providerId: string, voiceId: string): string {
  return `${providerId}/${voiceId}`;
}

/** The global id of `voice`. */
export function voiceGlobalId(voice: Voice): string {
  return globalVoiceId(voice.providerId, voice.id);
}

/**
 * Splits a global voice id at its first `/`. Provider ids never contain a
 * slash; voice ids may. Returns `undefined` when there is no provider part.
 */
export function splitVoiceId(
  globalId: string,
): { readonly providerId: string; readonly voiceId: string } | undefined {
  const slash = globalId.indexOf('/');
  if (slash <= 0) return undefined;
  return { providerId: globalId.slice(0, slash), voiceId: globalId.slice(slash + 1) };
}

/** Lower-cases a locale tag and turns `_` into `-` (Android reports `en_US`). */
export function normaliseLocale(locale: string): string {
  return locale.trim().replace(/_/g, '-').toLowerCase();
}

/** What `selectVoice` looks for. */
export interface VoiceRequest {
  /** Global voice id. */
  readonly voiceId?: string | undefined;
  /** Locale tag; matches the exact tag first, then the same language. */
  readonly locale?: string | undefined;
}

/**
 * Picks a voice from `voices` (callers pass only the voices they are willing
 * to use, normally the local ones): by id, else by locale (exact tag, then
 * same language, preferring the provider's default), else the default voice,
 * else the first. `undefined` only when `voices` is empty.
 */
export function selectVoice(
  voices: readonly Voice[],
  request: VoiceRequest = {},
): Voice | undefined {
  if (voices.length === 0) return undefined;
  if (request.voiceId !== undefined) {
    const byId = voices.find((voice) => voiceGlobalId(voice) === request.voiceId);
    if (byId) return byId;
  }
  if (request.locale !== undefined && request.locale.trim() !== '') {
    const wanted = normaliseLocale(request.locale);
    const language = wanted.split('-')[0] ?? wanted;
    const exact = voices.filter((voice) => normaliseLocale(voice.locale) === wanted);
    const sameLanguage = voices.filter(
      (voice) => (normaliseLocale(voice.locale).split('-')[0] ?? '') === language,
    );
    for (const group of [exact, sameLanguage]) {
      const best = group.find((voice) => voice.isDefault === true) ?? group[0];
      if (best) return best;
    }
  }
  return voices.find((voice) => voice.isDefault === true) ?? voices[0];
}
