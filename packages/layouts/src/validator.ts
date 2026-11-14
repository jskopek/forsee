import {
  DWELL_CLASSES,
  LAYOUT_SCHEMA_VERSION,
  type LayoutDefinition,
  type ValidationIssue,
  type ValidationResult,
} from '@forsee/plugin-api';
import type { LayoutValidator } from './contracts';

/**
 * Layout validator (hand-written; it is the source of truth, and
 * `layouts/layout.schema.json` is kept in lock-step by tests).
 *
 * Policy decisions:
 * - **Unknown fields are errors**, at every level. A typo such as `"dwellclass"`
 *   would otherwise silently change how a key behaves, and users of a gaze
 *   keyboard cannot easily notice. The one exception is a root `"$schema"`
 *   string, so editors can attach the JSON Schema; it is dropped from the result.
 *   Format evolution goes through `schemaVersion`.
 * - **All issues are reported**, not just the first, each with a JSON-pointer
 *   path (`/pages/0/rows/1/keys/3/action/command`; `~` and `/` in names are
 *   escaped as `~0` and `~1`).
 * - The returned `value` is the input object itself (typed), not a copy, except
 *   that a root `$schema` is removed. Callers must not mutate it.
 *
 * What the schema file cannot express (id uniqueness, page references, group
 * rules, the coarse target limit) is checked here only.
 */

/** Layout ids: `<name>` or `<pluginId>/<name>`, lower case. */
export const LAYOUT_ID_PATTERN = '^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._-]*)*$';
/** Page and key ids: used inside target ids (`<layout>/<page>/<key>`), so no `/`. */
export const LOCAL_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]*$';
/** A plausible BCP 47 tag: language, optional script, region, variants. Not a registry lookup. */
export const LOCALE_PATTERN =
  '^[A-Za-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|[0-9]{3}))?(-([A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*$';

/** Largest number of targets on one screen of a coarse layout. */
export const COARSE_MAX_TARGETS = 12;

/** Reserved id of the automatic "back" key shown while a group is open. */
export const GROUP_BACK_KEY_ID = '$back';

const LAYOUT_ID_RE = new RegExp(LAYOUT_ID_PATTERN);
const LOCAL_ID_RE = new RegExp(LOCAL_ID_PATTERN);
const LOCALE_RE = new RegExp(LOCALE_PATTERN);

const MAX_ARGS_DEPTH = 16;

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeSegment(segment: string | number): string {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function isJsonValue(value: unknown, depth: number): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object': {
      if (depth > MAX_ARGS_DEPTH) return false;
      if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) return false;
      return Object.values(value).every((item) => isJsonValue(item, depth + 1));
    }
    default:
      return false;
  }
}

class Collector {
  readonly issues: ValidationIssue[] = [];
  add(path: string, message: string): void {
    this.issues.push({ path, message });
  }
}

interface KeyInfo {
  readonly path: string;
  readonly pageIndex: number;
}

interface Context {
  readonly out: Collector;
  readonly family: string | undefined;
  readonly keyIds: Map<string, KeyInfo>;
  /** Page ids declared anywhere (collected first, so forward references work). */
  readonly pageIds: ReadonlySet<string>;
}

function checkFields(
  out: Collector,
  path: string,
  obj: Obj,
  allowed: readonly string[],
  extra?: string,
): void {
  for (const name of Object.keys(obj)) {
    if (!allowed.includes(name) && name !== extra) {
      out.add(`${path}/${escapeSegment(name)}`, `Unknown field "${name}".`);
    }
  }
}

function requireString(
  out: Collector,
  path: string,
  obj: Obj,
  name: string,
  options: { optional?: boolean; allowEmpty?: boolean } = {},
): string | undefined {
  const value = obj[name];
  const here = `${path}/${name}`;
  if (value === undefined) {
    if (!options.optional) out.add(here, `"${name}" is required.`);
    return undefined;
  }
  if (typeof value !== 'string') {
    out.add(here, `"${name}" must be a string.`);
    return undefined;
  }
  if (value.length === 0 && options.allowEmpty !== true) {
    out.add(here, `"${name}" must not be empty.`);
    return undefined;
  }
  return value;
}

function checkWeight(out: Collector, path: string, obj: Obj, name: 'width' | 'height'): void {
  const value = obj[name];
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    out.add(`${path}/${name}`, `"${name}" must be a positive finite number.`);
  }
}

function checkAction(out: Collector, path: string, value: unknown, ctx: Context): void {
  if (!isObject(value)) {
    out.add(path, 'An action must be an object with a "command".');
    return;
  }
  checkFields(out, path, value, ['command', 'args']);
  const command = requireString(out, path, value, 'command');
  const args = value.args;
  if (args !== undefined) {
    if (!isObject(args)) {
      out.add(`${path}/args`, '"args" must be a JSON object.');
    } else if (!isJsonValue(args, 0)) {
      out.add(
        `${path}/args`,
        '"args" must contain only JSON values (finite numbers, no undefined).',
      );
    }
  }
  if (command === 'layout.showPage') {
    const page = isObject(args) ? args.page : undefined;
    if (typeof page !== 'string') {
      out.add(`${path}/args/page`, '"layout.showPage" needs a string "page" argument.');
    } else if (!ctx.pageIds.has(page)) {
      out.add(`${path}/args/page`, `Page "${page}" does not exist.`);
    }
  }
}

function checkBehaviour(out: Collector, path: string, value: unknown, ctx: Context): void {
  if (!isObject(value)) {
    out.add(path, '"behaviour" must be an object with a "type".');
    return;
  }
  const type = value.type;
  if (type === 'single') {
    checkFields(out, path, value, ['type']);
  } else if (type === 'repeat') {
    checkFields(out, path, value, ['type', 'intervalMs']);
    const interval = value.intervalMs;
    if (
      interval !== undefined &&
      (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0)
    ) {
      out.add(`${path}/intervalMs`, '"intervalMs" must be a positive finite number.');
    }
  } else if (type === 'escalate') {
    checkFields(out, path, value, ['type', 'steps', 'stepDwellClasses']);
    const steps = value.steps;
    let stepCount = 0;
    if (!Array.isArray(steps) || steps.length === 0) {
      out.add(`${path}/steps`, '"steps" must be an array with at least one action.');
    } else {
      stepCount = steps.length;
      steps.forEach((step: unknown, i) => {
        checkAction(out, `${path}/steps/${i}`, step, ctx);
      });
    }
    const classes = value.stepDwellClasses;
    if (classes !== undefined) {
      if (!Array.isArray(classes)) {
        out.add(`${path}/stepDwellClasses`, '"stepDwellClasses" must be an array.');
      } else {
        if (stepCount > 0 && classes.length > stepCount) {
          out.add(
            `${path}/stepDwellClasses`,
            `"stepDwellClasses" has more entries (${classes.length}) than "steps" (${stepCount}).`,
          );
        }
        classes.forEach((c: unknown, i) => {
          if (typeof c !== 'string' || !(DWELL_CLASSES as readonly string[]).includes(c)) {
            out.add(`${path}/stepDwellClasses/${i}`, `Must be one of ${DWELL_CLASSES.join(', ')}.`);
          }
        });
      }
    }
  } else {
    out.add(`${path}/type`, '"type" must be "single", "repeat" or "escalate".');
  }
}

function registerKeyId(
  ctx: Context,
  path: string,
  pageIndex: number,
  id: string | undefined,
): void {
  if (id === undefined) return;
  if (!LOCAL_ID_RE.test(id)) {
    ctx.out.add(
      `${path}/id`,
      `Key id "${id}" must start with a letter or digit and contain only letters, digits, ".", "_" and "-".`,
    );
  }
  const earlier = ctx.keyIds.get(id);
  if (earlier) {
    ctx.out.add(`${path}/id`, `Duplicate key id "${id}" (first used at ${earlier.path}).`);
  } else {
    ctx.keyIds.set(id, { path, pageIndex });
  }
}

const ACTION_KEY_FIELDS = [
  'id',
  'width',
  'label',
  'icon',
  'action',
  'dwellClass',
  'behaviour',
  'returnToPage',
] as const;

function checkLabel(out: Collector, path: string, obj: Obj): void {
  const label = requireString(out, path, obj, 'label', { allowEmpty: true });
  requireString(out, path, obj, 'icon', { optional: true });
  if (label === '' && (typeof obj.icon !== 'string' || obj.icon === '')) {
    out.add(`${path}/label`, '"label" must not be empty unless the key has an "icon".');
  }
}

/** Checks an action key; returns the number of targets it contributes (always 1). */
function checkActionKey(
  ctx: Context,
  path: string,
  pageIndex: number,
  obj: Obj,
  inGroup: boolean,
): void {
  const { out } = ctx;
  checkFields(out, path, obj, ACTION_KEY_FIELDS);
  registerKeyId(ctx, path, pageIndex, requireString(out, path, obj, 'id'));
  checkWeight(out, path, obj, 'width');
  checkLabel(out, path, obj);
  const action = obj.action;
  if (action === undefined) out.add(`${path}/action`, '"action" is required.');
  else checkAction(out, `${path}/action`, action, ctx);

  const dwell = obj.dwellClass;
  if (dwell !== undefined) {
    if (typeof dwell !== 'string' || !(DWELL_CLASSES as readonly string[]).includes(dwell)) {
      out.add(`${path}/dwellClass`, `"dwellClass" must be one of ${DWELL_CLASSES.join(', ')}.`);
    }
  }
  if (obj.behaviour !== undefined) {
    checkBehaviour(out, `${path}/behaviour`, obj.behaviour, ctx);
  }
  const back = obj.returnToPage;
  if (back !== undefined) {
    if (typeof back !== 'string' || !ctx.pageIds.has(back)) {
      out.add(
        `${path}/returnToPage`,
        typeof back === 'string'
          ? `Page "${back}" does not exist.`
          : '"returnToPage" must be a page id.',
      );
    } else if (isObject(action) && action.command === 'layout.showPage') {
      out.add(
        `${path}/returnToPage`,
        '"returnToPage" conflicts with a "layout.showPage" action (which page wins is ambiguous).',
      );
    }
  }
  if (inGroup && isObject(action) && action.command === 'layout.back') {
    out.add(`${path}/action`, 'Groups get an automatic back key; do not add "layout.back" to one.');
  }
}

/** Checks a group key; `count` receives targets shown while the group is open. */
function checkGroupKey(
  ctx: Context,
  path: string,
  pageIndex: number,
  obj: Obj,
): { openCount: number } {
  const { out } = ctx;
  checkFields(out, path, obj, ['id', 'width', 'label', 'icon', 'group', 'keys', 'columns']);
  registerKeyId(ctx, path, pageIndex, requireString(out, path, obj, 'id'));
  checkWeight(out, path, obj, 'width');
  checkLabel(out, path, obj);
  const keys = obj.keys;
  let openCount = 0;
  if (!Array.isArray(keys) || keys.length < 2) {
    out.add(`${path}/keys`, '"keys" must be an array with at least two action keys.');
  } else {
    openCount = keys.length + 1; // plus the automatic back key
    keys.forEach((sub: unknown, i) => {
      const subPath = `${path}/keys/${i}`;
      if (!isObject(sub)) {
        out.add(subPath, 'A key must be an object.');
      } else if (sub.group !== undefined || sub.spacer !== undefined) {
        out.add(
          subPath,
          'Groups hold action keys only; groups do not nest and spacers are not allowed.',
        );
      } else {
        checkActionKey(ctx, subPath, pageIndex, sub, true);
      }
    });
  }
  const columns = obj.columns;
  if (columns !== undefined) {
    if (typeof columns !== 'number' || !Number.isInteger(columns) || columns < 1) {
      out.add(`${path}/columns`, '"columns" must be a positive integer.');
    }
  }
  return { openCount };
}

function checkSpacer(ctx: Context, path: string, pageIndex: number, obj: Obj): void {
  const { out } = ctx;
  checkFields(out, path, obj, ['id', 'width', 'spacer']);
  registerKeyId(ctx, path, pageIndex, requireString(out, path, obj, 'id'));
  checkWeight(out, path, obj, 'width');
}

function checkPage(ctx: Context, path: string, pageIndex: number, page: unknown): void {
  const { out } = ctx;
  if (!isObject(page)) {
    out.add(path, 'A page must be an object.');
    return;
  }
  checkFields(out, path, page, ['id', 'name', 'rows']);
  const id = requireString(out, path, page, 'id');
  if (id !== undefined && !LOCAL_ID_RE.test(id)) {
    out.add(
      `${path}/id`,
      `Page id "${id}" must start with a letter or digit and contain only letters, digits, ".", "_" and "-".`,
    );
  }
  requireString(out, path, page, 'name');
  const rows = page.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    out.add(`${path}/rows`, '"rows" must be an array with at least one row.');
    return;
  }
  let targets = 0;
  rows.forEach((row: unknown, r) => {
    const rowPath = `${path}/rows/${r}`;
    if (!isObject(row)) {
      out.add(rowPath, 'A row must be an object.');
      return;
    }
    checkFields(out, rowPath, row, ['keys', 'height']);
    checkWeight(out, rowPath, row, 'height');
    const keys = row.keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      out.add(`${rowPath}/keys`, '"keys" must be an array with at least one key.');
      return;
    }
    keys.forEach((key: unknown, k) => {
      const keyPath = `${rowPath}/keys/${k}`;
      if (!isObject(key)) {
        out.add(keyPath, 'A key must be an object.');
        return;
      }
      const isSpacer = key.spacer !== undefined;
      const isGroup = key.group !== undefined;
      const hasAction = key.action !== undefined;
      if (isSpacer && key.spacer !== true) {
        out.add(`${keyPath}/spacer`, '"spacer" must be true.');
      }
      if (isGroup && key.group !== true) {
        out.add(`${keyPath}/group`, '"group" must be true.');
      }
      if (isSpacer && (isGroup || hasAction)) {
        out.add(keyPath, 'A spacer cannot also have "action" or "group".');
        return;
      }
      if (isGroup && hasAction) {
        out.add(keyPath, 'A key has either "action" or "group", not both.');
        return;
      }
      if (isSpacer) {
        checkSpacer(ctx, keyPath, pageIndex, key);
        return;
      }
      targets += 1;
      if (isGroup) {
        const { openCount } = checkGroupKey(ctx, keyPath, pageIndex, key);
        if (ctx.family === 'coarse' && openCount > COARSE_MAX_TARGETS) {
          out.add(
            `${keyPath}/keys`,
            `A coarse group may show at most ${COARSE_MAX_TARGETS} targets including the back key; this one shows ${openCount}.`,
          );
        }
      } else {
        checkActionKey(ctx, keyPath, pageIndex, key, false);
      }
    });
  });
  if (ctx.family === 'coarse' && targets > COARSE_MAX_TARGETS) {
    out.add(
      path,
      `A coarse page may have at most ${COARSE_MAX_TARGETS} targets; "${id ?? ''}" has ${targets}.`,
    );
  }
}

/** Validates untrusted JSON into a `LayoutDefinition`. See the file comment for policy. */
export const validateLayout: LayoutValidator = (
  json: unknown,
): ValidationResult<LayoutDefinition> => {
  const out = new Collector();
  if (!isObject(json)) {
    out.add('', 'A layout must be a JSON object.');
    return { ok: false, issues: out.issues };
  }
  checkFields(
    out,
    '',
    json,
    ['schemaVersion', 'id', 'name', 'description', 'family', 'locale', 'initialPage', 'pages'],
    '$schema',
  );
  if (json.$schema !== undefined && typeof json.$schema !== 'string') {
    out.add('/$schema', '"$schema" must be a string.');
  }

  if (json.schemaVersion !== LAYOUT_SCHEMA_VERSION) {
    out.add(
      '/schemaVersion',
      json.schemaVersion === undefined
        ? '"schemaVersion" is required.'
        : `Unsupported schemaVersion ${JSON.stringify(json.schemaVersion)}; this app reads version ${LAYOUT_SCHEMA_VERSION}.`,
    );
  }
  const id = requireString(out, '', json, 'id');
  if (id !== undefined && !LAYOUT_ID_RE.test(id)) {
    out.add(
      '/id',
      `Layout id "${id}" must be lower case segments of letters, digits, ".", "_" and "-", separated by "/".`,
    );
  }
  requireString(out, '', json, 'name');
  requireString(out, '', json, 'description', { optional: true });
  const family = json.family;
  if (family !== 'precise' && family !== 'coarse') {
    out.add('/family', '"family" must be "precise" or "coarse".');
  }
  const locale = requireString(out, '', json, 'locale');
  if (locale !== undefined && !LOCALE_RE.test(locale)) {
    out.add(
      '/locale',
      `"${locale}" is not a plausible BCP 47 language tag (for example "en" or "de-DE").`,
    );
  }
  const initialPage = requireString(out, '', json, 'initialPage');

  const pages = json.pages;
  if (!Array.isArray(pages) || pages.length === 0) {
    out.add('/pages', '"pages" must be an array with at least one page.');
    return { ok: false, issues: out.issues };
  }

  // Collect page ids first so references can point forward.
  const pageIds = new Set<string>();
  pages.forEach((page: unknown, i) => {
    if (isObject(page) && typeof page.id === 'string' && page.id !== '') {
      if (pageIds.has(page.id)) {
        out.add(`/pages/${i}/id`, `Duplicate page id "${page.id}".`);
      }
      pageIds.add(page.id);
    }
  });
  if (initialPage !== undefined && !pageIds.has(initialPage)) {
    out.add('/initialPage', `Page "${initialPage}" does not exist.`);
  }

  const ctx: Context = {
    out,
    family: typeof family === 'string' ? family : undefined,
    keyIds: new Map(),
    pageIds,
  };
  pages.forEach((page: unknown, i) => {
    checkPage(ctx, `/pages/${i}`, i, page);
  });

  if (out.issues.length > 0) return { ok: false, issues: out.issues };
  const { $schema: _ignored, ...rest } = json;
  return { ok: true, value: rest as unknown as LayoutDefinition };
};
