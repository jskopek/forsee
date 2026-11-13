/**
 * @forsee/layouts: layout schema validator, JSON Schema, layout-to-rectangle
 * geometry, gaze target generation, the layout runtime (groups, page
 * switching, key behaviours) and the built-in precise and coarse layouts
 * (work package B7). Contracts are in `contracts.ts`.
 *
 * Keyboard view recipe:
 * 1. `const runtime = createLayoutRuntime(layout)`.
 * 2. `const { targets } = targetsForView(runtime.view, bounds, { gapPx, edgeGrowthPx })`;
 *    register them with the gaze `TargetRegistry`, and again on every
 *    `runtime.onDidChangeView` or bounds change.
 * 3. On each `ActivateEvent`: `const action = runtime.activate(keyIdOfTarget(...), event.repeatIndex)`;
 *    if non-null, `commands.execute(action.command, action.args)`.
 */
export * from './contracts';
export {
  createLayoutCatalogue,
  builtinCatalogue,
  BUILTIN_LAYOUTS,
  FALLBACK_LOCALE,
  LAYOUT_JSON_SCHEMA,
  getBuiltinLayout,
  listLayouts,
  pickDefaultLayout,
} from './catalogue';
export {
  DESTRUCTIVE_COMMANDS,
  actionForRepeat,
  defaultDwellClassForAction,
  dwellClassForRepeat,
  escalationStep,
  keyRepeatIntervalMs,
  repeatsWhileGazed,
  resolveKeyDwellClass,
} from './dwell';
export { computeGeometry, computeSlots, type KeySlot } from './geometry';
export { isActionKey, isGroupKey, isSpacer } from './keys';
export { GROUP_BACK_KEY, createLayoutRuntime, groupRows } from './runtime';
export {
  generateTargets,
  keyIdOfTarget,
  keyText,
  targetId,
  targetsForView,
  type ViewTargets,
} from './targets';
export {
  COARSE_MAX_TARGETS,
  GROUP_BACK_KEY_ID,
  LAYOUT_ID_PATTERN,
  LOCAL_ID_PATTERN,
  LOCALE_PATTERN,
  validateLayout,
} from './validator';

/** Command ids declared by this package (see `contracts.ts`). */
export const LAYOUT_COMMAND_IDS = ['layout.showPage', 'layout.back'] as const;

/** Package name, for diagnostics. */
export const LAYOUTS_PACKAGE = '@forsee/layouts';
