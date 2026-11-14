import { useEffect } from 'react';
import { useHostUi } from './provider';

/** The parts of an `AudioParam` the click sound uses. */
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
}

/** The parts of an audio node the click sound uses. */
export interface AudioNodeLike {
  connect(destination: never): unknown;
}

/** The parts of a Web Audio `AudioContext` the click sound uses. */
export interface AudioContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  createOscillator(): AudioNodeLike & {
    type: string;
    readonly frequency: AudioParamLike;
    start(when?: number): void;
    stop(when?: number): void;
  };
  createGain(): AudioNodeLike & { readonly gain: AudioParamLike };
  resume?(): Promise<void>;
  close?(): Promise<void>;
}

/** Creates the audio context, or returns null when audio is unavailable. */
export type AudioContextFactory = () => AudioContextLike | null;

/** Options of `createClickSound`. */
export interface ClickSoundOptions {
  /** Pitch, Hz. Default 1200. */
  readonly frequencyHz?: number;
  /** Length, ms. Default 35. */
  readonly durationMs?: number;
  /** Peak gain, 0..1. Default 0.18. */
  readonly volume?: number;
}

/** A short dwell click. */
export interface ClickSound {
  /** Plays the click; a no-op without audio or before audio is unlocked. */
  play(): void;
  /** Asks the context to start (call from a user gesture to unlock audio). */
  unlock(): void;
  dispose(): void;
}

/** The browser's `AudioContext`, or null when there is none. */
export const browserAudioContextFactory: AudioContextFactory = () => {
  const Ctor = (globalThis as { AudioContext?: new () => AudioContextLike }).AudioContext;
  return Ctor ? new Ctor() : null;
};

/**
 * A tiny Web Audio blip (an oscillator with a fast decay), no audio files.
 * The context is created lazily on first use through the injected factory;
 * when the factory returns null or throws, or the context is not running
 * yet (browsers start it suspended until a user gesture), `play` does
 * nothing, so selections are never held up by audio.
 */
export function createClickSound(
  factory: AudioContextFactory,
  options: ClickSoundOptions = {},
): ClickSound {
  const frequency = options.frequencyHz ?? 1200;
  const duration = (options.durationMs ?? 35) / 1000;
  const volume = Math.min(1, Math.max(0.0001, options.volume ?? 0.18));
  let context: AudioContextLike | null | undefined;
  let disposed = false;

  const get = (): AudioContextLike | null => {
    if (disposed) return null;
    if (context === undefined) {
      try {
        context = factory();
      } catch {
        context = null;
      }
    }
    return context;
  };

  const unlock = (): void => {
    const ctx = get();
    if (!ctx || ctx.state === 'running' || !ctx.resume) return;
    ctx.resume().catch(() => undefined);
  };

  return {
    play() {
      const ctx = get();
      if (!ctx) return;
      if (ctx.state !== 'running') {
        unlock();
        return;
      }
      try {
        const t = ctx.currentTime;
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, t);
        gain.gain.setValueAtTime(volume, t);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
        oscillator.connect(gain as never);
        gain.connect(ctx.destination as never);
        oscillator.start(t);
        oscillator.stop(t + duration);
      } catch {
        // Audio is a nicety; never let it break a selection.
      }
    },
    unlock,
    dispose() {
      if (disposed) return;
      disposed = true;
      context?.close?.().catch(() => undefined);
      context = null;
    },
  };
}

/** Options of `useClickSound`. */
export interface UseClickSoundOptions {
  /** Off by default; wire it to a setting. */
  readonly enabled?: boolean;
  /** Default: the browser's `AudioContext`. */
  readonly factory?: AudioContextFactory;
  readonly sound?: ClickSoundOptions;
}

/**
 * Plays a click on every activation (gaze or direct) while `enabled`. The
 * first pointer or key press anywhere unlocks audio.
 */
export function useClickSound({
  enabled = false,
  factory = browserAudioContextFactory,
  sound,
}: UseClickSoundOptions = {}): void {
  const { hub } = useHostUi();
  const [frequencyHz, durationMs, volume] = [sound?.frequencyHz, sound?.durationMs, sound?.volume];

  useEffect(() => {
    if (!enabled) return undefined;
    const click = createClickSound(factory, {
      ...(frequencyHz === undefined ? {} : { frequencyHz }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(volume === undefined ? {} : { volume }),
    });
    const subscription = hub.onAnyActivate(() => click.play());
    const target = typeof window === 'undefined' ? null : window;
    const unlock = (): void => click.unlock();
    target?.addEventListener('pointerdown', unlock, { once: true });
    target?.addEventListener('keydown', unlock, { once: true });
    return () => {
      subscription.dispose();
      target?.removeEventListener('pointerdown', unlock);
      target?.removeEventListener('keydown', unlock);
      click.dispose();
    };
  }, [enabled, factory, hub, frequencyHz, durationMs, volume]);
}
