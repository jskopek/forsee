import {
  createContext,
  useCallback,
  useContext,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

/**
 * Where the user was in Settings (section, page of a list, open plugin), kept
 * while Settings is closed so it reopens at the same place: open, nudge a
 * value, close, try it, reopen and nudge again. Lives as long as the main
 * screen; a reload starts Settings afresh.
 */
const SettingsPosition = createContext<Map<string, unknown> | null>(null);

/** Keeps the Settings position for everything inside it (the main screen). */
export function SettingsPositionProvider({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  const [memory] = useState(() => new Map<string, unknown>());
  return <SettingsPosition.Provider value={memory}>{children}</SettingsPosition.Provider>;
}

/**
 * `useState` whose value is remembered under `key` across Settings being
 * closed and opened again. Without a provider it is plain `useState`.
 */
export function useSettingsPosition<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const memory = useContext(SettingsPosition);
  const [value, setValue] = useState<T>(() =>
    memory?.has(key) === true ? (memory.get(key) as T) : initial,
  );
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) =>
      setValue((previous) => {
        const resolved = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next;
        memory?.set(key, resolved);
        return resolved;
      }),
    [memory, key],
  );
  return [value, set];
}
