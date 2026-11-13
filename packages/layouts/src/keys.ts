import type { LayoutActionKey, LayoutGroupKey, LayoutKey, LayoutSpacer } from '@forsee/plugin-api';

/** True for spacers (empty space that is not a target). */
export function isSpacer(key: LayoutKey): key is LayoutSpacer {
  return key.spacer === true;
}

/** True for two-step group keys. */
export function isGroupKey(key: LayoutKey): key is LayoutGroupKey {
  return key.group === true;
}

/** True for keys that run an action. */
export function isActionKey(key: LayoutKey): key is LayoutActionKey {
  return key.spacer !== true && key.group !== true;
}
