import { EventBus, type Clock, type Disposable } from '@forsee/core';
import {
  parseVoiceId,
  type SpeechEvents,
  type SpeechHandle,
  type Utterance,
  type Voice,
} from '@forsee/plugin-api';
import { chunkText, wordLengthAt, type TextChunk } from './chunking';
import type {
  SpeechSynthesisLike,
  SpeechSynthesisUtteranceLike,
  SpeechSynthesisVoiceLike,
  WebSpeechProvider,
  WebSpeechProviderOptions,
} from './contracts';
import { createSpeechSession, type SpeechSession } from './session';

/** Id of the web speech provider. */
export const WEB_SPEECH_PROVIDER_ID = 'forsee.web-speech';

const DEFAULT_MAX_CHUNK = 180;
const DEFAULT_VOICES_TIMEOUT = 2000;
/** Delay before the priming utterance is cancelled (the legacy prototype's 20 ms). */
const PRIME_CANCEL_MS = 20;

interface Run {
  readonly utterance: Utterance;
  readonly session: SpeechSession;
  readonly chunks: readonly TextChunk[];
  index: number;
  /** Held until `unlock()`. */
  waiting: boolean;
  cancelled: boolean;
  /** Keeps the browser utterance reachable: Chromium drops `end` events of garbage-collected ones. */
  pinned: SpeechSynthesisUtteranceLike | undefined;
}

/**
 * The web speech provider (`forsee.web-speech`): speech through an injected
 * `window.speechSynthesis`.
 *
 * Quirks handled:
 * - Voices load asynchronously: `listVoices` waits for `voiceschanged`
 *   (bounded by `voicesTimeoutMs`) when the browser reports none yet.
 * - Only `localService` voices are offered and used unless `localOnly` is
 *   false, so the app works offline.
 * - Long text is split at sentence ends into pieces of at most
 *   `maxChunkChars`, spoken one after another as one utterance (Chromium cuts
 *   long utterances off); boundary offsets refer to the original text.
 * - `cancel()` races: every browser utterance is tied to one run; events from
 *   a cancelled or superseded run are ignored, whatever order they arrive in,
 *   and `stop()` ends the handle synchronously instead of waiting for the
 *   browser's `interrupted` error.
 * - Boundary events are optional (some platforms never send them); a missing
 *   `charLength` is derived from the text.
 * - Speech needs a user gesture first: a `not-allowed` error before any
 *   audio (or `requireUnlock`) puts the provider in the `locked` state and
 *   holds the utterance; `unlock()` from a click plays it. This is the
 *   behaviour of the prototype's `SpeechWarningModal`.
 */
export function createWebSpeechProvider(options: WebSpeechProviderOptions): WebSpeechProvider {
  return new WebSpeechProviderImpl(options);
}

class WebSpeechProviderImpl implements WebSpeechProvider {
  readonly id: string;
  private readonly synthesis: SpeechSynthesisLike;
  private readonly clock: Clock;
  private readonly localOnly: boolean;
  private readonly maxChunk: number;
  private readonly voicesTimeout: number;
  private readonly lockEvents = new EventBus<{ changed: boolean }>({
    onListenerError: () => undefined,
  });
  private isLocked: boolean;
  private active: Run | undefined;
  private voicesWait: Promise<void> | undefined;
  private primer: SpeechSynthesisUtteranceLike | undefined;
  private disposed = false;

  constructor(private readonly options: WebSpeechProviderOptions) {
    this.id = options.id ?? WEB_SPEECH_PROVIDER_ID;
    this.synthesis = options.synthesis;
    this.clock = options.clock;
    this.localOnly = options.localOnly ?? true;
    this.maxChunk = options.maxChunkChars ?? DEFAULT_MAX_CHUNK;
    this.voicesTimeout = options.voicesTimeoutMs ?? DEFAULT_VOICES_TIMEOUT;
    this.isLocked = options.requireUnlock ?? false;
  }

  get locked(): boolean {
    return this.isLocked;
  }

  onLockedChange(listener: (locked: boolean) => void): Disposable {
    return this.lockEvents.on('changed', listener);
  }

  // ---------------------------------------------------------------- voices

  async listVoices(): Promise<readonly Voice[]> {
    if (this.readVoices().length === 0) await this.waitForVoices();
    return this.readVoices().map((voice) => this.toVoice(voice));
  }

  private readVoices(): readonly SpeechSynthesisVoiceLike[] {
    let voices: readonly SpeechSynthesisVoiceLike[];
    try {
      voices = this.synthesis.getVoices();
    } catch {
      return [];
    }
    return this.localOnly ? voices.filter((voice) => voice.localService) : voices;
  }

  /** Waits for `voiceschanged`, or the timeout. Shared by concurrent callers. */
  private waitForVoices(): Promise<void> {
    this.voicesWait ??= new Promise<void>((resolve) => {
      const finish = (): void => {
        this.synthesis.removeEventListener('voiceschanged', finish);
        timer.dispose();
        this.voicesWait = undefined;
        resolve();
      };
      const timer = this.clock.setTimeout(finish, this.voicesTimeout);
      this.synthesis.addEventListener('voiceschanged', finish);
    });
    return this.voicesWait;
  }

  private toVoice(voice: SpeechSynthesisVoiceLike): Voice {
    return {
      id: voice.voiceURI,
      providerId: this.id,
      name: voice.name,
      locale: voice.lang.replace(/_/g, '-'),
      local: voice.localService,
      ...(voice.default ? { isDefault: true } : {}),
    };
  }

  /**
   * The browser voice to use: the requested one if it is allowed, else the
   * default or first allowed one. `null` leaves the choice to the browser,
   * which is only done when it reports no voices at all or `localOnly` is off.
   * `undefined` means voices exist but none is allowed (offline speech is
   * impossible).
   */
  private pickVoice(voiceId: string | undefined): SpeechSynthesisVoiceLike | null | undefined {
    const allowed = this.readVoices();
    if (voiceId !== undefined) {
      const parts = parseVoiceId(voiceId);
      const uri = parts?.providerId === this.id ? parts.voiceId : voiceId;
      const found = allowed.find((voice) => voice.voiceURI === uri);
      if (found) return found;
    }
    if (!this.localOnly && voiceId === undefined) return null;
    const preferred = allowed.find((voice) => voice.default) ?? allowed[0];
    if (preferred) return preferred;
    let anyVoices: boolean;
    try {
      anyVoices = this.synthesis.getVoices().length > 0;
    } catch {
      anyVoices = false;
    }
    return anyVoices ? undefined : null;
  }

  // ---------------------------------------------------------------- speaking

  speak(utterance: Utterance, events: SpeechEvents): SpeechHandle {
    if (this.active) this.stopRun(this.active, 'stopped');
    const run: Run = {
      utterance,
      session: createSpeechSession(utterance.id, events, this.clock, () => this.cancelRun(run)),
      chunks: chunkText(utterance.text, this.maxChunk),
      index: 0,
      waiting: false,
      cancelled: false,
      pinned: undefined,
    };
    if (this.disposed) {
      run.session.fail('The web speech provider was disposed');
      return run.session.handle;
    }
    if (run.chunks.length === 0) {
      run.session.start();
      run.session.end('completed');
      return run.session.handle;
    }
    this.active = run;
    if (this.isLocked) {
      run.waiting = true;
    } else {
      this.speakChunk(run);
    }
    return run.session.handle;
  }

  stop(): void {
    if (this.active) this.stopRun(this.active, 'stopped');
  }

  unlock(): void {
    const held = this.active;
    if (held?.waiting) {
      held.waiting = false;
      this.setLocked(false);
      this.speakChunk(held);
      return;
    }
    if (this.active) {
      this.setLocked(false); // speech is already flowing
      return;
    }
    this.prime();
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.lockEvents.dispose();
  }

  /** Speaks a silent, instant utterance inside the user gesture, as the legacy prototype did. */
  private prime(): void {
    let primer: SpeechSynthesisUtteranceLike;
    try {
      primer = this.options.createUtterance('');
      primer.volume = 0;
      primer.rate = 10;
      const unlocked = (): void => this.setLocked(false);
      primer.onstart = unlocked;
      primer.onend = unlocked;
      primer.onerror = (event: never) => {
        const code = errorCode(event);
        if (code === 'not-allowed') this.setLocked(true);
      };
      this.primer = primer;
      this.synthesis.speak(primer);
      // Inside a gesture, a call that does not throw is as good as proof.
      this.setLocked(false);
    } catch {
      this.setLocked(true);
      return;
    }
    this.clock.setTimeout(() => {
      if (this.primer === primer) this.primer = undefined;
      if (!this.active) this.safeCancel();
    }, PRIME_CANCEL_MS);
  }

  private setLocked(locked: boolean): void {
    if (this.isLocked === locked) return;
    this.isLocked = locked;
    this.lockEvents.emit('changed', locked);
  }

  private safeCancel(): void {
    try {
      this.synthesis.cancel();
    } catch {
      // Nothing more can be done.
    }
  }

  /** What `handle.stop()` runs: marks the run dead and cancels the browser. */
  private cancelRun(run: Run): void {
    run.cancelled = true;
    run.pinned = undefined;
    const wasWaiting = run.waiting;
    run.waiting = false;
    if (this.active === run) this.active = undefined;
    if (!wasWaiting) this.safeCancel();
  }

  private stopRun(run: Run, reason: 'stopped'): void {
    if (run.session.ended) return;
    this.cancelRun(run);
    run.session.end(reason);
  }

  private finishRun(run: Run, reason: 'completed' | 'stopped'): void {
    run.pinned = undefined;
    if (this.active === run) this.active = undefined;
    run.session.end(reason);
  }

  private speakChunk(run: Run): void {
    const chunk = run.chunks[run.index];
    if (!chunk) {
      this.finishRun(run, 'completed');
      return;
    }
    const voice = this.pickVoice(run.utterance.voiceId);
    if (voice === undefined) {
      this.failRun(run, 'No offline voice is available');
      return;
    }
    let browser: SpeechSynthesisUtteranceLike;
    try {
      browser = this.options.createUtterance(chunk.text);
    } catch (error) {
      this.failRun(run, messageOf(error));
      return;
    }
    if (voice !== null) {
      browser.voice = voice;
      browser.lang = voice.lang;
    }
    if (run.utterance.rate !== undefined) browser.rate = run.utterance.rate;
    if (run.utterance.pitch !== undefined) browser.pitch = run.utterance.pitch;
    if (run.utterance.volume !== undefined) browser.volume = run.utterance.volume;

    const stale = (): boolean => run.cancelled || this.active !== run || run.pinned !== browser;
    browser.onstart = () => {
      if (stale()) return;
      this.setLocked(false);
      run.session.start();
    };
    browser.onboundary = (event: never) => {
      if (stale()) return;
      const info = event as { name?: unknown; charIndex?: unknown; charLength?: unknown };
      if (info.name !== undefined && info.name !== 'word') return;
      if (typeof info.charIndex !== 'number' || !Number.isFinite(info.charIndex)) return;
      const length =
        typeof info.charLength === 'number' && info.charLength > 0
          ? info.charLength
          : wordLengthAt(chunk.text, info.charIndex);
      run.session.boundary(chunk.start + info.charIndex, length);
    };
    browser.onend = () => {
      if (stale()) return;
      run.index += 1;
      if (run.index < run.chunks.length) this.speakChunk(run);
      else this.finishRun(run, 'completed');
    };
    browser.onerror = (event: never) => {
      if (stale()) return;
      const code = errorCode(event);
      if (code === 'interrupted' || code === 'canceled') {
        // Something other than us cancelled the browser queue.
        this.finishRun(run, 'stopped');
      } else if (code === 'not-allowed' && !run.session.started) {
        run.pinned = undefined;
        run.waiting = true;
        this.setLocked(true);
      } else {
        this.failRun(run, `Speech synthesis failed: ${code}`);
      }
    };

    run.pinned = browser;
    try {
      this.synthesis.speak(browser);
    } catch (error) {
      this.failRun(run, messageOf(error));
    }
  }

  private failRun(run: Run, message: string): void {
    if (run.session.ended) return;
    run.pinned = undefined;
    run.cancelled = true;
    if (this.active === run) this.active = undefined;
    this.safeCancel();
    run.session.fail(message);
  }
}

function errorCode(event: unknown): string {
  const code = (event as { error?: unknown } | null | undefined)?.error;
  return typeof code === 'string' ? code : 'unknown';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
