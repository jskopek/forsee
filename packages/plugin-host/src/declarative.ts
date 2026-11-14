import { DisposableStore, type Kernel } from '@forsee/core';
import type { LayoutValidator } from '@forsee/layouts';
import type {
  Disposable,
  LayoutDefinition,
  PhraseSet,
  PluginManifest,
  SettingField,
  ThemeDefinition,
  ValidationIssue,
  ValidationResult,
  Vocabulary,
} from '@forsee/plugin-api';
import {
  validatePhraseSet,
  validateSettingFieldsJson,
  validateTheme,
  validateVocabulary,
} from './contribution-validators';
import type { PluginFiles, SettingsSchemaHolder } from './contracts';
import { isPlainObject } from './guards';
import { Issues } from './issues';
import { CONTRIBUTED_FILE_KINDS } from './manifest';
import { isSafeRelativePath, LOCAL_ID } from './patterns';

/** Largest contributed JSON file read, in UTF-16 code units. */
export const MAX_CONTRIBUTED_FILE_SIZE = 2 * 1024 * 1024;

/** Validated declarative contributions of one plugin, ids already prefixed. */
export interface DeclarativeContributions {
  readonly layouts: readonly LayoutDefinition[];
  readonly themes: readonly ThemeDefinition[];
  readonly phraseSets: readonly PhraseSet[];
  readonly vocabularies: readonly Vocabulary[];
  /** From `contributes.settings`; absent when the manifest declares none. */
  readonly settings?: readonly SettingField[];
}

type FileKind = (typeof CONTRIBUTED_FILE_KINDS)[number];

/**
 * Reads and validates every file listed in `manifest.contributes`. Ids are
 * prefixed with the plugin id (`<pluginId>/<name>`) before validation. If
 * any file is unreadable or invalid, the result lists every issue (paths
 * start with `/contributes/<kind>/<index>`) and nothing is returned, so a
 * plugin is loaded whole or not at all.
 */
export async function loadDeclarativeContributions(
  manifest: PluginManifest,
  files: PluginFiles,
  validateLayout: LayoutValidator,
): Promise<ValidationResult<DeclarativeContributions>> {
  const issues = new Issues();
  const validators: Record<FileKind, (json: unknown) => ValidationResult<unknown>> = {
    layouts: validateLayout,
    themes: validateTheme,
    phraseSets: validatePhraseSet,
    vocabularies: validateVocabulary,
  };
  const out: Record<FileKind, unknown[]> = {
    layouts: [],
    themes: [],
    phraseSets: [],
    vocabularies: [],
  };
  const contributes = manifest.contributes ?? {};
  for (const kind of CONTRIBUTED_FILE_KINDS) {
    const ids = new Set<string>();
    const list = contributes[kind] ?? [];
    for (let index = 0; index < list.length; index += 1) {
      const file = list[index] ?? '';
      const path = `/contributes/${kind}/${index}`;
      if (!isSafeRelativePath(file)) {
        issues.add(path, `Unsafe path ${JSON.stringify(file)}`);
        continue;
      }
      let text: string;
      try {
        text = await files.readText(file);
      } catch (error) {
        issues.add(
          path,
          `${file}: could not be read (${error instanceof Error ? error.message : String(error)})`,
        );
        continue;
      }
      if (typeof text !== 'string' || text.length > MAX_CONTRIBUTED_FILE_SIZE) {
        issues.add(path, `${file}: larger than ${MAX_CONTRIBUTED_FILE_SIZE} characters`);
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (error) {
        issues.add(
          path,
          `${file}: not valid JSON (${error instanceof Error ? error.message : String(error)})`,
        );
        continue;
      }
      if (!isPlainObject(json)) {
        issues.add(path, `${file}: expected a JSON object`);
        continue;
      }
      const prefixed = prefixContributionId(manifest.id, json.id);
      if (prefixed === null) {
        issues.add(`${path}/id`, `${file}: invalid or missing id`);
        continue;
      }
      if (ids.has(prefixed)) {
        issues.add(`${path}/id`, `${file}: duplicate ${kind} id "${prefixed}"`);
        continue;
      }
      ids.add(prefixed);
      const result = validators[kind]({ ...json, id: prefixed });
      if (!result.ok) {
        for (const issue of result.issues)
          issues.add(`${path}${issue.path}`, `${file}: ${issue.message}`);
        continue;
      }
      out[kind].push(result.value);
    }
  }
  let settings: SettingField[] | undefined;
  if (contributes.settings !== undefined) {
    const result = validateSettingFieldsJson(contributes.settings);
    if (result.ok) settings = result.value;
    else issues.addAll('/contributes/settings', result.issues);
  }
  if (!issues.ok) return { ok: false, issues: issues.list };
  return {
    ok: true,
    value: {
      layouts: out.layouts as LayoutDefinition[],
      themes: out.themes as ThemeDefinition[],
      phraseSets: out.phraseSets as PhraseSet[],
      vocabularies: out.vocabularies as Vocabulary[],
      ...(settings === undefined ? {} : { settings }),
    },
  };
}

/** `<pluginId>/<local>` for a contributed id, or `null` if it is not a valid id. */
export function prefixContributionId(pluginId: string, id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const local = id.startsWith(`${pluginId}/`) ? id.slice(pluginId.length + 1) : id;
  if (!LOCAL_ID.test(local) || local.includes('..')) return null;
  return `${pluginId}/${local}`;
}

/**
 * Registers validated contributions with the kernel under the plugin's id.
 * Returns one disposable that unregisters them all. If a registration
 * throws (for example a `duplicate` id clash with another owner), the ones
 * already made are undone and the error is rethrown.
 */
export function registerDeclarativeContributions(
  kernel: Kernel,
  pluginId: string,
  contributions: DeclarativeContributions,
  settingsSchema: SettingsSchemaHolder,
): Disposable {
  const store = new DisposableStore();
  try {
    for (const layout of contributions.layouts) {
      store.add(kernel.extensions.register('layouts', pluginId, layout));
    }
    for (const theme of contributions.themes) {
      store.add(kernel.extensions.register('themes', pluginId, theme));
    }
    for (const phraseSet of contributions.phraseSets) {
      store.add(kernel.extensions.register('phraseSets', pluginId, phraseSet));
    }
    for (const vocabulary of contributions.vocabularies) {
      store.add(kernel.extensions.register('vocabularies', pluginId, vocabulary));
    }
    if (contributions.settings !== undefined) settingsSchema.replace(contributions.settings);
  } catch (error) {
    store.dispose();
    throw error;
  }
  return store;
}

/** Issues for a manifest with no readable `contributes` (helper for callers' messages). */
export function issuesSummary(issues: readonly ValidationIssue[], max = 5): string {
  const shown = issues.slice(0, max).map((i) => `${i.path || '/'}: ${i.message}`);
  const more = issues.length > max ? ` (and ${issues.length - max} more)` : '';
  return shown.join('; ') + more;
}
