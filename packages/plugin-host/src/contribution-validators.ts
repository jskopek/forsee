import { validateSettingFields } from '@forsee/core';
import type {
  PhraseSet,
  SettingField,
  SettingType,
  ThemeDefinition,
  ThemeToken,
  ValidationResult,
  Vocabulary,
} from '@forsee/plugin-api';
import { LIMITS } from './guards';
import { Issues } from './issues';
import {
  LOCAL_ID,
  LOCALE,
  MAX_SETTING_KEY_LENGTH,
  SAFE_PATH,
  MAX_PATH_LENGTH,
  PLUGIN_ID,
  SETTING_KEY,
} from './patterns';

/**
 * Validators for the declarative contribution types the plugin host loads
 * itself (themes, phrase sets, vocabularies, setting schemas). Layouts are
 * validated by `@forsee/layouts` (`LayoutValidator`), injected.
 *
 * Contribution ids are checked as *local* ids or as already prefixed
 * `<pluginId>/<local>` ids; the loader prefixes them.
 */

/** Every theme token (kept in step with `ThemeToken` by the type below). */
const THEME_TOKEN_SET = {
  background: true,
  surface: true,
  text: true,
  textMuted: true,
  border: true,
  keyBack: true,
  keyFront: true,
  keyBorder: true,
  keyText: true,
  functionBack: true,
  functionFront: true,
  functionBorder: true,
  functionText: true,
  predictionBack: true,
  predictionFront: true,
  predictionBorder: true,
  predictionText: true,
  dangerBack: true,
  dangerFront: true,
  dangerBorder: true,
  dangerText: true,
  primaryBack: true,
  primaryFront: true,
  primaryBorder: true,
  primaryText: true,
  dwellProgress: true,
  focusRing: true,
  warningBack: true,
  warningText: true,
} as const satisfies Record<ThemeToken, true>;

/** All theme tokens. */
export const THEME_TOKENS = Object.keys(THEME_TOKEN_SET) as readonly ThemeToken[];

/**
 * CSS colour values a theme may use: hex, a colour keyword, or a colour
 * function with numeric arguments. Deliberately excludes `url(...)`,
 * `var(...)`, `;`, braces and quotes, so a theme can never make the app
 * fetch anything or inject other CSS.
 */
export const CSS_COLOR =
  /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[a-zA-Z]{3,32}|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([0-9a-z.,%\s/+-]{1,64}\))$/;

/** Contribution id: a local id, or `<something>/<local id>` once prefixed. */
function contributionId(issues: Issues, path: string, value: unknown): void {
  if (!issues.string(path, value, { min: 1, max: 256 })) return;
  const parts = value.split('/');
  const local = parts.length === 2 ? (parts[1] ?? '') : value;
  const owner = parts.length === 2 ? (parts[0] ?? '') : '';
  if (parts.length > 2 || (parts.length === 2 && !PLUGIN_ID.test(owner))) {
    issues.add(path, 'Invalid id: expected <name> or <pluginId>/<name>');
    return;
  }
  if (!LOCAL_ID.test(local) || local.includes('..')) {
    issues.add(path, 'Invalid id: use letters, digits, "_", "-" and "." (no "..")');
  }
}

function label(issues: Issues, path: string, value: unknown, required = true): void {
  issues.string(path, value, { required, min: 1, max: LIMITS.labelLength });
}

// ---------------------------------------------------------------- themes

/** Validates untrusted JSON into a `ThemeDefinition`. */
export function validateTheme(json: unknown): ValidationResult<ThemeDefinition> {
  const issues = new Issues();
  const o = issues.object('', json, ['id', 'name', 'colorScheme', 'tokens', 'fontScale']);
  if (o) {
    contributionId(issues, '/id', o.id);
    label(issues, '/name', o.name);
    if (o.colorScheme !== 'light' && o.colorScheme !== 'dark') {
      issues.add('/colorScheme', 'Expected "light" or "dark"');
    }
    const tokens = issues.object('/tokens', o.tokens, THEME_TOKENS);
    if (tokens) {
      for (const [key, value] of Object.entries(tokens)) {
        if (!(key in THEME_TOKEN_SET)) continue;
        if (typeof value !== 'string' || !CSS_COLOR.test(value)) {
          issues.add(`/tokens/${key}`, 'Expected a CSS colour (hex, keyword or colour function)');
        }
      }
    }
    if (o.fontScale !== undefined) {
      issues.number('/fontScale', o.fontScale, { min: 0.5, max: 4 });
    }
  }
  return issues.result(() => json as ThemeDefinition);
}

// ---------------------------------------------------------------- phrase sets

/** Validates untrusted JSON into a `PhraseSet`. */
export function validatePhraseSet(json: unknown): ValidationResult<PhraseSet> {
  const issues = new Issues();
  const o = issues.object('', json, ['schemaVersion', 'id', 'name', 'locale', 'categories']);
  if (o) {
    if (o.schemaVersion !== 1) issues.add('/schemaVersion', 'Expected 1');
    contributionId(issues, '/id', o.id);
    label(issues, '/name', o.name);
    issues.string('/locale', o.locale, { min: 2, max: 35, pattern: LOCALE });
    if (issues.array('/categories', o.categories, { max: 200 })) {
      const categoryIds = new Set<string>();
      o.categories.forEach((category, ci) => {
        const cp = `/categories/${ci}`;
        const c = issues.object(cp, category, ['id', 'name', 'phrases']);
        if (!c) return;
        if (issues.string(`${cp}/id`, c.id, { min: 1, max: 128, pattern: LOCAL_ID })) {
          if (categoryIds.has(c.id)) issues.add(`${cp}/id`, `Duplicate category id "${c.id}"`);
          categoryIds.add(c.id);
        }
        label(issues, `${cp}/name`, c.name);
        if (!issues.array(`${cp}/phrases`, c.phrases, { max: 1000 })) return;
        const phraseIds = new Set<string>();
        c.phrases.forEach((phrase, pi) => {
          const pp = `${cp}/phrases/${pi}`;
          const p = issues.object(pp, phrase, ['id', 'text', 'label', 'recording']);
          if (!p) return;
          if (issues.string(`${pp}/id`, p.id, { min: 1, max: 128, pattern: LOCAL_ID })) {
            if (phraseIds.has(p.id)) issues.add(`${pp}/id`, `Duplicate phrase id "${p.id}"`);
            phraseIds.add(p.id);
          }
          issues.string(`${pp}/text`, p.text, { min: 1, max: 1000 });
          label(issues, `${pp}/label`, p.label, false);
          issues.string(`${pp}/recording`, p.recording, {
            required: false,
            min: 1,
            max: MAX_PATH_LENGTH,
            pattern: SAFE_PATH,
            patternMessage: 'Expected a safe relative path inside the plugin folder',
          });
        });
      });
    }
  }
  return issues.result(() => json as PhraseSet);
}

// ---------------------------------------------------------------- vocabularies

/** Validates untrusted JSON into a `Vocabulary`. */
export function validateVocabulary(json: unknown): ValidationResult<Vocabulary> {
  const issues = new Issues();
  const o = issues.object('', json, ['schemaVersion', 'id', 'name', 'locale', 'entries']);
  if (o) {
    if (o.schemaVersion !== 1) issues.add('/schemaVersion', 'Expected 1');
    contributionId(issues, '/id', o.id);
    label(issues, '/name', o.name);
    issues.string('/locale', o.locale, { min: 2, max: 35, pattern: LOCALE });
    if (issues.array('/entries', o.entries, { max: 100_000 })) {
      o.entries.forEach((entry, i) => {
        const p = `/entries/${i}`;
        const e = issues.object(p, entry, ['text', 'weight']);
        if (!e) return;
        issues.string(`${p}/text`, e.text, { min: 1, max: 200 });
        if (e.weight !== undefined) issues.number(`${p}/weight`, e.weight, { exclusiveMin: 0 });
      });
    }
  }
  return issues.result(() => json as Vocabulary);
}

// ---------------------------------------------------------------- settings

const SETTING_TYPES: readonly SettingType[] = ['string', 'number', 'boolean', 'select', 'range'];
const SETTING_FIELD_KEYS = [
  'key',
  'label',
  'type',
  'description',
  'default',
  'options',
  'min',
  'max',
  'step',
];

function isSettingValue(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * Validates untrusted JSON into setting fields: the shape here, then the
 * semantic rules of the core settings registry (`validateSettingFields`:
 * unique keys, bounds, options, valid defaults).
 */
export function validateSettingFieldsJson(json: unknown): ValidationResult<SettingField[]> {
  const issues = new Issues();
  if (!issues.array('', json, { max: LIMITS.settingFields })) {
    return { ok: false, issues: issues.list };
  }
  json.forEach((field, i) => {
    const p = `/${i}`;
    const f = issues.object(p, field, SETTING_FIELD_KEYS);
    if (!f) return;
    issues.string(`${p}/key`, f.key, {
      min: 1,
      max: MAX_SETTING_KEY_LENGTH,
      pattern: SETTING_KEY,
      patternMessage: 'Use letters, digits, "_", "." and "-"',
    });
    label(issues, `${p}/label`, f.label);
    if (!SETTING_TYPES.includes(f.type as SettingType)) {
      issues.add(`${p}/type`, `Expected one of ${SETTING_TYPES.join(', ')}`);
    }
    issues.string(`${p}/description`, f.description, {
      required: false,
      max: LIMITS.descriptionLength,
    });
    if (!isSettingValue(f.default)) {
      issues.add(`${p}/default`, 'Expected a string, finite number or boolean');
    } else if (typeof f.default === 'string' && f.default.length > LIMITS.textLength) {
      issues.add(`${p}/default`, 'Too long');
    }
    for (const bound of ['min', 'max', 'step'] as const) {
      if (f[bound] !== undefined) issues.number(`${p}/${bound}`, f[bound]);
    }
    if (f.options !== undefined && issues.array(`${p}/options`, f.options, { max: 200 })) {
      f.options.forEach((option, oi) => {
        const op = `${p}/options/${oi}`;
        if (typeof option === 'string') {
          issues.string(op, option, { min: 1, max: LIMITS.labelLength });
          return;
        }
        const o = issues.object(op, option, ['label', 'value'], 'a string or { label, value }');
        if (!o) return;
        label(issues, `${op}/label`, o.label);
        if (!isSettingValue(o.value)) issues.add(`${op}/value`, 'Expected a setting value');
      });
    }
  });
  if (!issues.ok) return { ok: false, issues: issues.list };
  const fields = json as SettingField[];
  const semantic = validateSettingFields(fields);
  if (semantic.length > 0) return { ok: false, issues: semantic };
  return { ok: true, value: fields };
}
