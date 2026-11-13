import { ForseeError } from '@forsee/core';
import type { LayoutDefinition, LayoutFamily } from '@forsee/plugin-api';
import type { BuiltinLayoutCatalogue } from './contracts';
import deQwertz from '../layouts/de-qwertz.json';
import enAlphabetical from '../layouts/en-alphabetical.json';
import enCoarseGroups from '../layouts/en-coarse-groups.json';
import enQwerty from '../layouts/en-qwerty.json';
import layoutSchema from '../layouts/layout.schema.json';
import { validateLayout } from './validator';

/** Locale used when nothing matches. */
export const FALLBACK_LOCALE = 'en';

function load(json: unknown): LayoutDefinition {
  const result = validateLayout(json);
  if (!result.ok) {
    const first = result.issues[0];
    throw new ForseeError(
      'internal',
      `A built-in layout is invalid: ${first?.path ?? ''} ${first?.message ?? ''}`,
    );
  }
  return result.value;
}

/**
 * The JSON Schema (draft 2020-12) of the layout format, the same document as
 * `layouts/layout.schema.json`. Structural rules only; see its description.
 */
export const LAYOUT_JSON_SCHEMA: Readonly<Record<string, unknown>> = layoutSchema;

/**
 * Built-in layouts, in catalogue order: within a family and language the
 * first one is the default. Ids are `forsee/<name>`.
 */
export const BUILTIN_LAYOUTS: readonly LayoutDefinition[] = [
  load(enQwerty),
  load(enAlphabetical),
  load(deQwertz),
  load(enCoarseGroups),
];

/** Lower-cases a tag for comparison; `_` is accepted as a separator. */
function normaliseLocale(locale: string): string {
  return locale.trim().replace(/_/g, '-').toLowerCase();
}

function language(locale: string): string {
  return normaliseLocale(locale).split('-')[0] ?? '';
}

/** Layouts matching the optional filters. `locale` matches the exact tag or its language (`de` matches `de-DE`). */
export function listLayouts(
  layouts: readonly LayoutDefinition[],
  filter: { readonly family?: LayoutFamily; readonly locale?: string } = {},
): LayoutDefinition[] {
  return layouts.filter((layout) => {
    if (filter.family !== undefined && layout.family !== filter.family) return false;
    if (filter.locale === undefined) return true;
    const wanted = normaliseLocale(filter.locale);
    const have = normaliseLocale(layout.locale);
    return have === wanted || language(have) === language(wanted);
  });
}

/**
 * Picks the default layout for a family and locale from `layouts`:
 * 1. exact locale match (case-insensitive), first in list order;
 * 2. same language (`de` for `de-AT`, or `de-DE` for `de`);
 * 3. the fallback locale `en`;
 * 4. any layout of the family;
 * 5. the first layout of any family.
 * Throws `not-found` when `layouts` is empty.
 */
export function pickDefaultLayout(
  layouts: readonly LayoutDefinition[],
  family: LayoutFamily,
  locale: string,
): LayoutDefinition {
  const ofFamily = layouts.filter((l) => l.family === family);
  const wanted = normaliseLocale(locale);
  const exact = ofFamily.find((l) => normaliseLocale(l.locale) === wanted);
  const sameLanguage = ofFamily.find((l) => language(l.locale) === language(wanted));
  const fallback = ofFamily.find((l) => language(l.locale) === FALLBACK_LOCALE);
  const found = exact ?? sameLanguage ?? fallback ?? ofFamily[0] ?? layouts[0];
  if (!found) throw new ForseeError('not-found', 'There are no layouts to choose from.');
  return found;
}

/** A catalogue over any list of layouts (built-ins plus plugin layouts). */
export function createLayoutCatalogue(
  layouts: readonly LayoutDefinition[],
): BuiltinLayoutCatalogue {
  return {
    layouts,
    defaultFor: (family, locale) => pickDefaultLayout(layouts, family, locale),
  };
}

/** The built-in catalogue. */
export const builtinCatalogue: BuiltinLayoutCatalogue = createLayoutCatalogue(BUILTIN_LAYOUTS);

/** A built-in layout by id (`forsee/en-qwerty`), or undefined. */
export function getBuiltinLayout(id: string): LayoutDefinition | undefined {
  return BUILTIN_LAYOUTS.find((l) => l.id === id);
}
