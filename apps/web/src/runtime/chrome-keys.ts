import type { LayoutDefinition, LayoutKey } from '@forsee/plugin-api';
import type { ScreenLayout } from './settings';

/**
 * Commands the screen itself shows as fixed controls, per screen layout. A
 * keyboard's own keys for them are removed so each control exists once and
 * never moves when the keyboard or its page changes.
 */
export function chromeCommands(screen: ScreenLayout): readonly string[] {
  switch (screen) {
    case 'rail':
      return ['composition.speak'];
    case 'top':
      return ['composition.speak', 'composition.clear'];
    case 'current':
      return [];
  }
}

/**
 * `definition` without the keys whose action is one of `commands` (inside
 * group keys too). Rows left empty are dropped, so the rest of the row or
 * page takes the room. Returns `definition` itself when nothing matches.
 */
export function withoutKeysFor(
  definition: LayoutDefinition,
  commands: readonly string[],
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
