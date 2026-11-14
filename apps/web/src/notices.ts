import { useCallback, useEffect, useState } from 'react';
import type { ForseeRuntime } from './runtime';

/** A notice beside the text bar. */
export interface Notice {
  readonly id: string;
  readonly tone: 'warning' | 'error';
  readonly title: string;
  readonly message: string;
  /** Text that could not be spoken, which can be put back into the message. */
  readonly unspoken?: string;
}

/** Most notices kept; the oldest go first. */
const MAX_NOTICES = 6;

const STORAGE_MESSAGE =
  'This browser is not keeping Forsee’s data: what you type, say and change will be lost when the page closes.';

function storageNotice(runtime: ForseeRuntime): Notice | null {
  if (runtime.profile.persistent && runtime.profile.warning === undefined) return null;
  return {
    id: 'storage',
    tone: 'warning',
    title: 'Nothing is being saved',
    message: runtime.profile.warning ?? STORAGE_MESSAGE,
  };
}

function unspokenTitle(reason: 'no-service' | 'no-voice' | 'error'): string {
  if (reason === 'error') return 'Could not speak';
  return 'Could not speak: no voice on this device';
}

/**
 * The notices to show, newest first: storage that does not persist, and
 * text that could not be spoken (`speech.unavailable`). A message the user
 * wrote keeps its own notice (with its text, so a partner can read it, and a
 * way to put it back); unlogged announcements share one notice.
 */
export function useNotices(runtime: ForseeRuntime): {
  readonly notices: readonly Notice[];
  readonly dismiss: (id: string) => void;
} {
  const [notices, setNotices] = useState<readonly Notice[]>(() => {
    const storage = storageNotice(runtime);
    return storage ? [storage] : [];
  });

  useEffect(() => {
    let counter = 0;
    const subscription = runtime.speech.onUnavailable((event) => {
      counter += 1;
      const logged = event.recordId !== null;
      const notice: Notice = {
        id: logged ? `unspoken-${counter}` : 'unspoken-announcement',
        tone: 'error',
        title: unspokenTitle(event.reason),
        message: event.text,
        ...(logged ? { unspoken: event.text } : {}),
      };
      setNotices((current) =>
        [notice, ...current.filter((n) => n.id !== notice.id)].slice(0, MAX_NOTICES),
      );
    });
    return () => subscription.dispose();
  }, [runtime]);

  const dismiss = useCallback((id: string) => {
    setNotices((current) => current.filter((n) => n.id !== id));
  }, []);
  return { notices, dismiss };
}
