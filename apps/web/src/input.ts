import type { CommandArgsMap } from '@forsee/plugin-api';
import { useEffect } from 'react';
import type { ForseeRuntime } from './runtime';

/**
 * Browsers allow speech only after a user gesture. The first pointer press
 * or key press anywhere unlocks it (and every later one while it is held),
 * so a carer's single click or tap is enough even when the user only dwells.
 */
export function useUnlockSpeechOnGesture(runtime: ForseeRuntime): void {
  useEffect(() => {
    let primed = false;
    const onGesture = (): void => {
      if (!primed || runtime.speech.locked) {
        primed = true;
        runtime.speech.unlock();
      }
    };
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
    return () => {
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
    };
  }, [runtime]);
}

type KeyCommand =
  | { readonly command: 'composition.insert'; readonly args: CommandArgsMap['composition.insert'] }
  | { readonly command: 'composition.deleteGrapheme' }
  | { readonly command: 'composition.speak' };

/** What a key press on a physical keyboard does, or null when it is not ours. */
export function physicalKeyCommand(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly repeat: boolean;
}): KeyCommand | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === 'Backspace') return { command: 'composition.deleteGrapheme' };
  if (event.key === 'Enter') return event.repeat ? null : { command: 'composition.speak' };
  // One printable character (letters, digits, punctuation, space); not "Shift", "F5", ...
  if (Array.from(event.key).length === 1) {
    return { command: 'composition.insert', args: { text: event.key } };
  }
  return null;
}

/**
 * Typing on a connected keyboard, for testers: printable keys insert,
 * Backspace deletes a letter, Enter speaks, all through the kernel's
 * commands. Off while `enabled` is false, while gaze is paused, inside any
 * dialog (the settings sheet keeps Tab, Enter and Space for its buttons),
 * and for shortcuts with Ctrl, Cmd or Alt. On the main screen it takes
 * Enter and Space before a focused button sees them.
 */
export function usePhysicalKeyboard(runtime: ForseeRuntime, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (runtime.gaze.pipeline.paused) return;
      const target = event.target;
      if (target instanceof Element && target.closest('[role="dialog"], input, textarea, select')) {
        return;
      }
      const action = physicalKeyCommand(event);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      runtime.kernel.commands
        .execute(action.command, 'args' in action ? action.args : undefined, 'keyboard')
        .catch((error: unknown) => runtime.reportError(error, `app.keyboard:${action.command}`));
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [runtime, enabled]);
}
