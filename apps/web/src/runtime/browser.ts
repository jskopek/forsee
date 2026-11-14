import type { AudioPlayer, SpeechSynthesisUtteranceLike } from '@forsee/speech';
import type { SpeechEndReason } from '@forsee/plugin-api';
import type { LifecycleEnvironment, SpeechSynthesisEnvironment } from './types';

/**
 * The real-browser defaults of `createForseeRuntime`. Each returns `null`
 * where the browser lacks the feature (and in Node), so the runtime degrades
 * instead of throwing.
 */

/** `window.speechSynthesis`, or null. */
export function browserSpeechSynthesis(): SpeechSynthesisEnvironment | null {
  const g = globalThis as {
    speechSynthesis?: SpeechSynthesis;
    SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
  };
  const synthesis = g.speechSynthesis;
  const Utterance = g.SpeechSynthesisUtterance;
  if (!synthesis || !Utterance) return null;
  return {
    synthesis,
    createUtterance: (text): SpeechSynthesisUtteranceLike => new Utterance(text),
  };
}

/** Plays recorded messages through an `HTMLAudioElement`, or null without one. */
export function browserAudioPlayer(): AudioPlayer | null {
  const g = globalThis as { Audio?: typeof Audio; URL?: typeof URL; Blob?: typeof Blob };
  const AudioElement = g.Audio;
  const Url = g.URL;
  const BlobType = g.Blob;
  if (!AudioElement || !Url || !BlobType || typeof Url.createObjectURL !== 'function') return null;
  return {
    play(audio, mimeType) {
      const url = Url.createObjectURL(new BlobType([audio.slice()], { type: mimeType }));
      const element = new AudioElement(url);
      let settle: (reason: SpeechEndReason) => void = () => undefined;
      const done = new Promise<SpeechEndReason>((resolve) => {
        settle = resolve;
      });
      let finished = false;
      const finish = (reason: SpeechEndReason): void => {
        if (finished) return;
        finished = true;
        element.onended = null;
        element.onerror = null;
        Url.revokeObjectURL(url);
        settle(reason);
      };
      element.onended = () => finish('completed');
      element.onerror = () => finish('error');
      element.play().catch(() => finish('error'));
      return {
        done,
        stop() {
          element.pause();
          finish('stopped');
        },
      };
    },
  };
}

/** The real `window` and `document`, or null in Node. */
export function browserLifecycle(): LifecycleEnvironment | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  return { window, document };
}
