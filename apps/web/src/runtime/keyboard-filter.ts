import type { LayoutDefinition, LayoutKey } from '@forsee/plugin-api';

/**
 * Commands a keyboard may not have keys for. Speak lives only in the control
 * bar, so it is in one place whatever keyboard or page is showing; Clear has
 * no key at all (holding Delete clears, and Undo brings the text back).
 * Built-in keyboards already leave them out; this also covers keyboards from
 * other plugins.
 */
export const CONTROL_BAR_COMMANDS: readonly string[] = ['composition.speak', 'composition.clear'];

/**
 * `definition` without the keys whose action is one of `commands` (inside
 * group keys too). Rows left empty are dropped, so the rest of the row or
 * page takes the room. A key that only reaches a command as a later step
 * (Delete escalating to clear) is kept. Returns `definition` itself when
 * nothing matches.
 */
export function withoutKeysFor(
  definition: LayoutDefinition,
  commands: readonly string[] = CONTROL_BAR_COMMANDS,
): LayoutDefinition {
  if (commands.length === 0) return definition;
  const drops = (key: LayoutKey): boolean =>
    'action' in key && key.action !== undefined && commands.includes(key.action.command);
  let changed = false;
  const pages = definition.pages.map((page) => ({
    ...page,
    rows: page.rows
      .map((row) => {
        const keys = row.keys
          .filter((key) => {
            if (!drops(key)) return true;
            changed = true;
            return false;
          })
          .map((key) => {
            if (!('group' in key) || key.group !== true) return key;
            const inner = key.keys.filter((k) => !drops(k));
            if (inner.length === key.keys.length) return key;
            changed = true;
            return { ...key, keys: inner };
          });
        return { ...row, keys };
      })
      .filter((row) => row.keys.length > 0),
  }));
  return changed ? { ...definition, pages } : definition;
}
