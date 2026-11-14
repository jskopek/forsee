import type { InputEventTarget, PointerEnvironment, PointerEventLike } from './contracts';

/** An event target that never fires, for environments without a DOM. */
const INERT_TARGET: InputEventTarget = {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

/**
 * The real browser environment. Without a `window` (Node, workers) it
 * reports no Pointer Events support, so a source started there fails with an
 * `unavailable` error instead of throwing.
 *
 * Viewport size is `innerWidth` x `innerHeight`, the same space `clientX` and
 * `clientY` are measured in.
 */
export function createBrowserPointerEnvironment(
  win: Window | undefined = typeof window === 'undefined' ? undefined : window,
): PointerEnvironment {
  if (!win) {
    return {
      document: INERT_TARGET,
      window: INERT_TARGET,
      supportsPointerEvents: () => false,
      viewport: () => ({ width: 0, height: 0 }),
      isVisible: () => false,
    };
  }
  const doc = win.document;
  return {
    document: doc,
    window: win,
    supportsPointerEvents: () => 'PointerEvent' in win,
    viewport: () => ({ width: win.innerWidth, height: win.innerHeight }),
    isVisible: () => doc.visibilityState !== 'hidden',
  };
}

/**
 * Adds a capture-phase listener (so app code calling `stopPropagation`
 * cannot hide input) and returns the function that removes it.
 */
export function listen(
  target: InputEventTarget,
  type: string,
  listener: (event: PointerEventLike) => void,
): () => void {
  target.addEventListener(type, listener, true);
  return () => target.removeEventListener(type, listener, true);
}
