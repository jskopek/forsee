import {
  defaultErrorReporter,
  EventBus,
  ForseeError,
  type Disposable,
  type ErrorReporter,
} from '@forsee/core';
import type {
  SpeakOptions,
  SpeechEndReason,
  SpeechEvents,
  SpeechHandle,
  Utterance,
  Voice,
  VoiceProvider,
} from '@forsee/plugin-api';
import type {
  SpeechEngine,
  SpeechEngineEventMap,
  SpeechServiceOptions,
  SpeechSettings,
  SpeechSettingsPatch,
  UtteranceQueue,
} from './contracts';
import { createUtteranceQueue } from './queue';
import { VoiceProviderRegistry } from './registry';
import { createSpeechSession } from './session';
import { applySpeechSettings, DEFAULT_SPEECH_SETTINGS } from './settings';
import { selectVoice, splitVoiceId, voiceGlobalId } from './voices';

/** Id of the recorded-message provider (message banking). */
export const RECORDED_PROVIDER_ID = 'forsee.recorded';

/**
 * Creates the speech engine: the kernel's `SpeechService`, built on the
 * utterance queue, a registry of voice providers (direct and contributed),
 * voice selection and the recorded-message fallback.
 *
 * Policy: `speak` queues after current speech unless `options.interrupt`
 * (or the engine `policy: 'interrupt'`) asks to cut in, in which case the
 * current utterance and everything queued are stopped first. `stop` is
 * synchronous and clears everything.
 *
 * Routing: a recording goes to the recorded provider and falls back to
 * synthesising its text when the recording is missing or fails before audio
 * starts (reported on `events` as `fallback`). Otherwise the voice id
 * (`<providerId>/<voiceId>`) names the provider; an unknown or absent id
 * goes to the default synthesis provider.
 */
export function createSpeechService(options: SpeechServiceOptions): SpeechEngine {
  return new Engine(options);
}

/** Same as `createSpeechService`. */
export const createSpeechEngine = createSpeechService;

class Engine implements SpeechEngine {
  readonly events: EventBus<SpeechEngineEventMap>;
  readonly queue: UtteranceQueue;
  private readonly registry: VoiceProviderRegistry;
  private readonly reportError: ErrorReporter;
  private readonly recordedId: string;
  private current: SpeechSettings;
  private voiceCache: readonly Voice[] = [];
  private disposed = false;
  private readonly subscriptions: Disposable[] = [];

  constructor(private readonly options: SpeechServiceOptions) {
    this.reportError = options.reportError ?? defaultErrorReporter;
    this.recordedId = options.recordedProviderId ?? RECORDED_PROVIDER_ID;
    this.events = new EventBus({ onListenerError: this.reportError });
    this.registry = new VoiceProviderRegistry({ reportError: this.reportError });
    this.queue = createUtteranceQueue({
      clock: options.clock,
      play: (utterance, events) => this.play(utterance, events),
      reportError: this.reportError,
      ...(options.watchdogMs ? { watchdogMs: options.watchdogMs } : {}),
    });
    this.subscriptions.push(this.queue.onEvent((event) => this.events.emit('speech', event)));

    const initial = applySpeechSettings(DEFAULT_SPEECH_SETTINGS, {
      ...options.defaults,
      ...(options.voiceId === undefined ? {} : { voiceId: options.voiceId }),
      ...(options.locale === undefined ? {} : { locale: options.locale }),
    });
    this.current = initial.settings;

    for (const provider of options.providers ?? []) this.registry.register(provider);
    if (options.extensions) this.subscriptions.push(this.registry.follow(options.extensions));
    this.subscriptions.push(
      this.registry.events.on('changed', () => {
        void this.refreshVoices();
      }),
    );
    void this.refreshVoices();
  }

  get settings(): SpeechSettings {
    return this.current;
  }

  // ---------------------------------------------------------------- SpeechService

  speak(text: string, options: SpeakOptions = {}): Promise<SpeechEndReason> {
    if (this.disposed) return Promise.resolve('stopped');
    const recording = options.recording;
    if (recording === undefined && text.trim() === '') return Promise.resolve('completed');
    const voiceId = this.preferredVoiceId(options.voiceId);
    const merged = applySpeechSettings(this.current, {
      ...(options.rate === undefined ? {} : { rate: options.rate }),
      ...(options.pitch === undefined ? {} : { pitch: options.pitch }),
      ...(options.volume === undefined ? {} : { volume: options.volume }),
    }).settings;
    const utterance: Utterance = {
      id: this.options.newId(),
      text,
      ...(voiceId === undefined ? {} : { voiceId }),
      rate: merged.rate,
      pitch: merged.pitch,
      volume: merged.volume,
      ...(recording === undefined ? {} : { recording }),
    };
    const interrupt = options.interrupt ?? this.options.policy === 'interrupt';
    if (interrupt) this.queue.stopAll();
    return this.queue.enqueue(utterance).done;
  }

  stop(): void {
    this.queue.stopAll();
  }

  // ---------------------------------------------------------------- voices and settings

  async listVoices(options: { readonly includeNetwork?: boolean } = {}): Promise<readonly Voice[]> {
    const voices = await this.registry.listVoices(options);
    if (options.includeNetwork !== true) this.setVoiceCache(voices);
    return voices;
  }

  setVoice(voiceId: string): void {
    if (typeof voiceId !== 'string' || voiceId.trim() === '') {
      throw new ForseeError('invalid-argument', 'A voice id must be a non-empty string');
    }
    this.updateSettings({ voiceId });
  }

  updateSettings(patch: SpeechSettingsPatch): SpeechSettings {
    const { settings } = applySpeechSettings(this.current, patch);
    this.current = settings;
    this.events.emit('settingsChanged', settings);
    return settings;
  }

  async resolveVoice(
    request: { readonly voiceId?: string; readonly locale?: string } = {},
  ): Promise<Voice | undefined> {
    const voices = await this.listVoices();
    return selectVoice(voices, {
      voiceId: request.voiceId ?? this.current.voiceId,
      locale: request.locale ?? this.current.locale,
    });
  }

  registerProvider(provider: VoiceProvider): Disposable {
    return this.registry.register(provider);
  }

  dispose(): void {
    if (this.disposed) return;
    this.queue.dispose();
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.registry.dispose();
    this.events.dispose();
  }

  // ---------------------------------------------------------------- internals

  private async refreshVoices(): Promise<void> {
    try {
      const voices = await this.registry.listVoices();
      if (!this.disposed) this.setVoiceCache(voices);
    } catch (error) {
      this.reportError(error, 'speech.refreshVoices');
    }
  }

  private setVoiceCache(voices: readonly Voice[]): void {
    const changed =
      voices.length !== this.voiceCache.length ||
      voices.some((voice, i) => {
        const old = this.voiceCache[i];
        return !old || voiceGlobalId(old) !== voiceGlobalId(voice);
      });
    this.voiceCache = voices;
    if (changed && !this.disposed) this.events.emit('voicesChanged', voices);
  }

  /**
   * Synchronous voice choice at speak time, from the cached local voices:
   * the requested id if it is offered, else the locale's voice, else
   * `undefined` (the provider's own default). With nothing cached yet the
   * requested id is passed through untouched.
   */
  private preferredVoiceId(explicit: string | undefined): string | undefined {
    const requested = explicit ?? this.current.voiceId;
    const locale = this.current.locale;
    if (this.voiceCache.length === 0) return requested;
    if (requested !== undefined && this.voiceCache.some((v) => voiceGlobalId(v) === requested)) {
      return requested;
    }
    if (requested === undefined && locale === undefined) return undefined;
    const picked = selectVoice(this.voiceCache, { locale });
    return picked ? voiceGlobalId(picked) : undefined;
  }

  private synthesisProvider(voiceId: string | undefined): {
    provider: VoiceProvider;
    voiceId: string | undefined;
  } {
    if (voiceId !== undefined) {
      const parts = splitVoiceId(voiceId);
      const named = parts ? this.registry.get(parts.providerId) : undefined;
      if (named && named.id !== this.recordedId) return { provider: named, voiceId };
    }
    const preferred = this.options.defaultProviderId;
    const fallback =
      (preferred === undefined ? undefined : this.registry.get(preferred)) ??
      this.registry.list().find((provider) => provider.id !== this.recordedId);
    if (!fallback) throw new ForseeError('unavailable', 'No voice provider is available');
    return { provider: fallback, voiceId: undefined };
  }

  private playSynthesis(utterance: Utterance, events: SpeechEvents): SpeechHandle {
    const { provider, voiceId } = this.synthesisProvider(utterance.voiceId);
    const { voiceId: _dropped, recording: _recording, ...rest } = utterance;
    const routed: Utterance = voiceId === undefined ? rest : { ...rest, voiceId };
    const handle = provider.speak(routed, events);
    return {
      utteranceId: handle.utteranceId,
      done: handle.done,
      stop: () => {
        try {
          handle.stop();
        } finally {
          try {
            provider.stop();
          } catch (error) {
            this.reportError(error, `speech.provider.stop:${provider.id}`);
          }
        }
      },
    };
  }

  private play(utterance: Utterance, events: SpeechEvents): SpeechHandle {
    if (utterance.recording === undefined) return this.playSynthesis(utterance, events);
    return this.playRecording(utterance, utterance.recording, events);
  }

  private playRecording(
    utterance: Utterance,
    recording: string,
    events: SpeechEvents,
  ): SpeechHandle {
    let active: SpeechHandle | undefined;
    const session = createSpeechSession(utterance.id, events, this.options.clock, () => {
      active?.stop();
    });

    let fellBack = false;
    const fallBack = (reason: string): void => {
      if (session.ended || fellBack) return;
      fellBack = true;
      this.events.emit('fallback', { utteranceId: utterance.id, recording, reason });
      try {
        active = this.playSynthesis(utterance, {
          onStart: () => session.start(),
          onBoundary: (event) => session.boundary(event.charIndex, event.charLength),
          onError: (event) => session.error(event.message),
          onEnd: (event) => session.end(event.reason),
        });
        void active.done.then((reason) => session.end(reason));
      } catch (error) {
        session.fail(error instanceof Error ? error.message : String(error));
      }
    };

    const recorded = this.registry.get(this.recordedId);
    if (!recorded) {
      fallBack('No recorded-message provider is registered');
      return session.handle;
    }
    let audioStarted = false;
    let failure = 'The recording could not be played';
    try {
      const handle = recorded.speak(utterance, {
        onStart: () => {
          audioStarted = true;
          session.start();
        },
        onBoundary: (event) => session.boundary(event.charIndex, event.charLength),
        onError: (event) => {
          if (audioStarted) session.error(event.message);
          else failure = event.message;
        },
        onEnd: (event) => {
          if (event.reason === 'error' && !audioStarted) fallBack(failure);
          else session.end(event.reason);
        },
      });
      if (!fellBack) active = handle;
    } catch (error) {
      fallBack(error instanceof Error ? error.message : String(error));
    }
    return session.handle;
  }
}
