import type { Clock } from '@forsee/core';
import type {
  SpeechEndReason,
  SpeechEvents,
  SpeechHandle,
  Utterance,
  Voice,
  VoiceProvider,
} from '@forsee/plugin-api';
import type {
  AudioPlayer,
  SpeechSynthesisLike,
  SpeechSynthesisUtteranceLike,
  SpeechSynthesisVoiceLike,
} from './contracts';
import { createSpeechSession, type SpeechSession } from './session';

/**
 * Test doubles for other packages' tests (`@forsee/speech/testing`): a
 * scriptable voice provider, a fake `speechSynthesis` and a fake audio
 * player. Nothing here makes sound or uses timers except through the
 * injected clock.
 */

// ------------------------------------------------------------------ fake voice provider

/** How a `FakeVoiceProvider` treats the next `speak` calls. */
export type FakeProviderBehaviour =
  /** Emits `start` and waits for `completeCurrent`/`failCurrent` (default). */
  | 'manual'
  /** Emits `start`, then ends `completed` after `autoCompleteMs` of the injected clock. */
  | 'auto'
  /** Never emits anything (a broken provider; exercises the watchdog). */
  | 'silent'
  /** `speak` throws. */
  | 'throw';

export interface FakeVoiceProviderOptions {
  readonly id?: string;
  readonly clock: Clock;
  readonly voices?: readonly Voice[];
  readonly behaviour?: FakeProviderBehaviour;
  /** Duration for `auto` behaviour. Default 100. */
  readonly autoCompleteMs?: number;
}

/** A scriptable `VoiceProvider`. Records every utterance it was asked to say. */
export class FakeVoiceProvider implements VoiceProvider {
  readonly id: string;
  /** Every utterance passed to `speak`, in order. */
  readonly spoken: Utterance[] = [];
  /** How many times `stop()` was called on the provider. */
  stopCalls = 0;
  behaviour: FakeProviderBehaviour;
  autoCompleteMs: number;
  voices: readonly Voice[];
  /** Makes `listVoices` reject with this. */
  listVoicesError: Error | undefined;
  private session: SpeechSession | undefined;
  private currentUtterance: Utterance | undefined;

  constructor(private readonly options: FakeVoiceProviderOptions) {
    this.id = options.id ?? 'fake';
    this.behaviour = options.behaviour ?? 'manual';
    this.autoCompleteMs = options.autoCompleteMs ?? 100;
    this.voices = options.voices ?? [fakeVoice(this.id, 'default', 'en-US', { isDefault: true })];
  }

  /** The utterance being spoken, if any. */
  get current(): Utterance | undefined {
    return this.session && !this.session.ended ? this.currentUtterance : undefined;
  }

  listVoices(): Promise<readonly Voice[]> {
    return this.listVoicesError
      ? Promise.reject(this.listVoicesError)
      : Promise.resolve(this.voices);
  }

  speak(utterance: Utterance, events: SpeechEvents): SpeechHandle {
    this.session?.handle.stop();
    this.spoken.push(utterance);
    if (this.behaviour === 'throw') throw new Error(`fake provider ${this.id} refuses to speak`);
    const session = createSpeechSession(utterance.id, events, this.options.clock, () => undefined);
    this.session = session;
    this.currentUtterance = utterance;
    if (this.behaviour === 'manual' || this.behaviour === 'auto') session.start();
    if (this.behaviour === 'auto') {
      const timer = this.options.clock.setTimeout(
        () => session.end('completed'),
        this.autoCompleteMs,
      );
      void session.handle.done.then(() => timer.dispose());
    }
    return session.handle;
  }

  stop(): void {
    this.stopCalls += 1;
    this.session?.handle.stop();
  }

  /** Emits a word boundary for the current utterance. */
  boundary(charIndex: number, charLength: number): void {
    this.session?.boundary(charIndex, charLength);
  }

  /** Ends the current utterance `completed`. */
  completeCurrent(): void {
    this.session?.start();
    this.session?.end('completed');
  }

  /** Emits `error` and ends the current utterance with `error`. */
  failCurrent(message = 'fake provider failure'): void {
    this.session?.fail(message);
  }

  /** Ends the current utterance with a reason, without any error event. */
  endCurrent(reason: SpeechEndReason): void {
    this.session?.end(reason);
  }
}

/** Builds a `Voice` for tests. */
export function fakeVoice(
  providerId: string,
  id: string,
  locale = 'en-US',
  extra: { local?: boolean; isDefault?: boolean; name?: string } = {},
): Voice {
  return {
    id,
    providerId,
    name: extra.name ?? id,
    locale,
    local: extra.local ?? true,
    ...(extra.isDefault ? { isDefault: true } : {}),
  };
}

// ------------------------------------------------------------------ fake speechSynthesis

/** A fake browser utterance: `SpeechSynthesisUtteranceLike` with a record of what happened to it. */
export class FakeBrowserUtterance implements SpeechSynthesisUtteranceLike {
  lang = '';
  voice: SpeechSynthesisVoiceLike | null = null;
  rate = 1;
  pitch = 1;
  volume = 1;
  onstart: ((event: never) => void) | null = null;
  onend: ((event: never) => void) | null = null;
  onerror: ((event: never) => void) | null = null;
  onboundary: ((event: never) => void) | null = null;
  constructor(public text: string) {}
}

export interface FakeSpeechSynthesisOptions {
  /** Voices available at once. Default none (Chromium loads them later: call `loadVoices`). */
  readonly voices?: readonly SpeechSynthesisVoiceLike[];
  /** Speech fails with `not-allowed` until `activate()` is called. Default false. */
  readonly requireActivation?: boolean;
}

/**
 * A scriptable `speechSynthesis`. Utterances queue up in `queue`; the test
 * drives the head with `start`, `boundary`, `end` and `error`. `cancel`
 * empties the queue and delivers `error: 'canceled'` to the head (as
 * Chromium does), immediately or, with `deferCancelEvents`, when
 * `flushCancelEvents` is called.
 */
export class FakeSpeechSynthesis implements SpeechSynthesisLike {
  /** Utterances handed to `speak` and not yet ended or cancelled; the head is playing. */
  queue: FakeBrowserUtterance[] = [];
  /** Every utterance ever handed to `speak`, in order. */
  readonly spoken: FakeBrowserUtterance[] = [];
  cancelCalls = 0;
  deferCancelEvents = false;
  activated: boolean;
  /** Makes `speak` throw. */
  speakError: Error | undefined;
  private voices: readonly SpeechSynthesisVoiceLike[];
  private readonly listeners = new Set<() => void>();
  private readonly cancelled: FakeBrowserUtterance[] = [];

  constructor(options: FakeSpeechSynthesisOptions = {}) {
    this.voices = options.voices ?? [];
    this.activated = !(options.requireActivation ?? false);
  }

  /** The browser utterance factory to pass as `createUtterance`. */
  readonly createUtterance = (text: string): FakeBrowserUtterance => new FakeBrowserUtterance(text);

  getVoices(): readonly SpeechSynthesisVoiceLike[] {
    return this.voices;
  }

  /** Sets the voices and fires `voiceschanged`. */
  loadVoices(voices: readonly SpeechSynthesisVoiceLike[]): void {
    this.voices = voices;
    for (const listener of [...this.listeners]) listener();
  }

  get voicesListenerCount(): number {
    return this.listeners.size;
  }

  addEventListener(_type: 'voiceschanged', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'voiceschanged', listener: () => void): void {
    this.listeners.delete(listener);
  }

  speak(utterance: unknown): void {
    if (this.speakError) throw this.speakError;
    const u = utterance as FakeBrowserUtterance;
    this.spoken.push(u);
    this.queue.push(u);
  }

  cancel(): void {
    this.cancelCalls += 1;
    const doomed = this.queue;
    this.queue = [];
    if (this.deferCancelEvents) {
      this.cancelled.push(...doomed.slice(0, 1));
    } else {
      this.deliverCancel(doomed[0]);
    }
  }

  /** Delivers the held `canceled` errors (with `deferCancelEvents`). */
  flushCancelEvents(): void {
    const held = this.cancelled.splice(0);
    for (const u of held) this.deliverCancel(u);
  }

  /** The user's first gesture happened: speech is allowed from now on. */
  activate(): void {
    this.activated = true;
  }

  /** The head utterance starts (or fails with `not-allowed` while not activated). */
  start(): void {
    const head = this.queue[0];
    if (!head) return;
    if (!this.activated) {
      this.queue.shift();
      head.onerror?.({ error: 'not-allowed' } as never);
      return;
    }
    head.onstart?.({} as never);
  }

  /** A word boundary on the head utterance. `charLength` may be omitted, as on some platforms. */
  boundary(charIndex: number, charLength?: number, name: string | undefined = 'word'): void {
    this.queue[0]?.onboundary?.({
      ...(name === undefined ? {} : { name }),
      charIndex,
      ...(charLength === undefined ? {} : { charLength }),
    } as never);
  }

  /** The head utterance ends normally and the next one (if any) is current. */
  end(): void {
    const head = this.queue.shift();
    head?.onend?.({} as never);
  }

  /** The head utterance fails with a Web Speech error code. */
  error(code: string): void {
    const head = this.queue.shift();
    head?.onerror?.({ error: code } as never);
  }

  private deliverCancel(u: FakeBrowserUtterance | undefined): void {
    u?.onerror?.({ error: 'canceled' } as never);
  }
}

/** Builds a browser voice for tests. */
export function fakeBrowserVoice(
  name: string,
  lang = 'en-US',
  extra: { localService?: boolean; default?: boolean } = {},
): SpeechSynthesisVoiceLike {
  return {
    voiceURI: name,
    name,
    lang,
    localService: extra.localService ?? true,
    default: extra.default ?? false,
  };
}

// ------------------------------------------------------------------ fake audio player

/** One playback started on a `FakeAudioPlayer`. */
export interface FakePlayback {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  stopped: boolean;
  /** Ends the playback with `reason` (default `completed`). */
  finish(reason?: SpeechEndReason): void;
}

/** A scriptable `AudioPlayer`. */
export class FakeAudioPlayer implements AudioPlayer {
  readonly plays: FakePlayback[] = [];
  /** Makes the next `play` throw this. */
  playError: Error | undefined;

  play(
    audio: Uint8Array,
    mimeType: string,
  ): { stop(): void; readonly done: Promise<SpeechEndReason> } {
    if (this.playError) throw this.playError;
    let resolve: (reason: SpeechEndReason) => void = () => undefined;
    const done = new Promise<SpeechEndReason>((r) => {
      resolve = r;
    });
    const playback: FakePlayback = {
      audio,
      mimeType,
      stopped: false,
      finish: (reason = 'completed') => resolve(reason),
    };
    this.plays.push(playback);
    return {
      done,
      stop: () => {
        playback.stopped = true;
        resolve('stopped');
      },
    };
  }

  get current(): FakePlayback | undefined {
    return this.plays.at(-1);
  }
}
