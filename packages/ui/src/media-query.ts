import { useCallback, useSyncExternalStore } from 'react';

/** The part of `window.matchMedia` the hook uses (injectable for tests). */
export type MatchMediaLike = (query: string) => {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
};

function browserMatchMedia(): MatchMediaLike | undefined {
  const g = globalThis as { matchMedia?: MatchMediaLike };
  return typeof g.matchMedia === 'function' ? g.matchMedia.bind(globalThis) : undefined;
}

/**
 * Whether a CSS media query matches, updated live (for example
 * `(orientation: portrait)` to stack the regions on a tall screen). False
 * where `matchMedia` does not exist.
 */
export function useMediaQuery(query: string, matchMedia?: MatchMediaLike): boolean {
  const match = matchMedia ?? browserMatchMedia();
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!match) return () => undefined;
      const list = match(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [match, query],
  );
  return useSyncExternalStore(
    subscribe,
    () => (match ? match(query).matches : false),
    () => false,
  );
}
