import type { PlatformInfo } from '@forsee/host';
import {
  API_VERSION,
  FIXED_PERMISSION_SCOPES,
  NETWORK_PERMISSION_PREFIX,
  REGION_IDS,
  type PermissionScope,
  type PluginManifest,
  type PluginPlatform,
  type TrustTier,
  type ValidationResult,
} from '@forsee/plugin-api';
import { validateSettingFieldsJson } from './contribution-validators';
import type {
  CompatibilityResult,
  CompatibilityTarget,
  ManifestValidationOptions,
} from './contracts';
import { LIMITS } from './guards';
import { Issues } from './issues';
import {
  FIRST_PARTY_ID_PREFIX,
  isValidHost,
  MAX_PATH_LENGTH,
  MAX_PLUGIN_ID_LENGTH,
  MAX_URL_LENGTH,
  PANEL_ID,
  PLUGIN_ID,
  RESERVED_ID_SEGMENTS,
  RESERVED_IDS,
  SAFE_PATH,
  URL_RE,
} from './patterns';
import { compareSemVer, isSemVer, MAX_VERSION_LENGTH, parseSemVer } from './semver';

/** Plugin API versions this host implements. */
export const SUPPORTED_API_VERSIONS: readonly number[] = [API_VERSION];

/** Platform families, in a stable order. */
export const PLUGIN_PLATFORMS: readonly PluginPlatform[] = ['desktop', 'mobile', 'web'];

/** Top-level manifest properties (`$schema` is allowed for editor support). */
export const MANIFEST_KEYS: readonly string[] = [
  '$schema',
  'id',
  'name',
  'version',
  'apiVersion',
  'minAppVersion',
  'description',
  'author',
  'authorUrl',
  'fundingUrl',
  'platforms',
  'main',
  'panels',
  'contributes',
  'permissions',
  'optionalPermissions',
];

/** Contributed file lists and their maximum length. */
export const CONTRIBUTED_FILE_KINDS = ['layouts', 'themes', 'phraseSets', 'vocabularies'] as const;
const MAX_CONTRIBUTED_FILES = 64;
const MAX_PANELS = 16;

/** Whether `scope` is a valid permission scope (fixed, or `network:<host>`). */
export function isPermissionScope(scope: unknown): scope is PermissionScope {
  if (typeof scope !== 'string') return false;
  if ((FIXED_PERMISSION_SCOPES as readonly string[]).includes(scope)) return true;
  return (
    scope.startsWith(NETWORK_PERMISSION_PREFIX) &&
    isValidHost(scope.slice(NETWORK_PERMISSION_PREFIX.length))
  );
}

/** Whether `id` is a syntactically valid plugin id (ignoring reservations). */
export function isPluginIdSyntax(id: unknown): id is string {
  return typeof id === 'string' && id.length <= MAX_PLUGIN_ID_LENGTH && PLUGIN_ID.test(id);
}

/** Why a plugin id is reserved for this origin, or `null` if it may be used. */
export function reservedIdReason(id: string, firstParty: boolean): string | null {
  const first = id.split('.')[0] ?? '';
  if (RESERVED_IDS.includes(id) || RESERVED_ID_SEGMENTS.includes(first)) {
    return `"${id}" is reserved for the app`;
  }
  if (first === FIRST_PARTY_ID_PREFIX && !firstParty) {
    return `The "${FIRST_PARTY_ID_PREFIX}." prefix is reserved for first-party plugins`;
  }
  return null;
}

function safePath(
  issues: Issues,
  path: string,
  value: unknown,
  extensions: readonly string[],
  required = true,
): void {
  if (
    !issues.string(path, value, {
      required,
      min: 1,
      max: MAX_PATH_LENGTH,
      pattern: SAFE_PATH,
      patternMessage:
        'Expected a relative path inside the plugin folder ("/" separators; no "..", leading "/", "\\", ":" or hidden segments)',
    })
  ) {
    return;
  }
  if (!extensions.some((ext) => value.toLowerCase().endsWith(ext))) {
    issues.add(path, `Expected a ${extensions.join(' or ')} file`);
  }
}

function scopeList(issues: Issues, path: string, value: unknown): PermissionScope[] {
  if (!issues.array(path, value, { required: false, max: 64 })) return [];
  const seen = new Set<string>();
  const out: PermissionScope[] = [];
  value.forEach((scope, i) => {
    if (!isPermissionScope(scope)) {
      issues.add(
        `${path}/${i}`,
        typeof scope === 'string' && scope.startsWith(NETWORK_PERMISSION_PREFIX)
          ? 'Invalid network scope: expected network:<lower-case host> with no scheme, port, path or wildcard'
          : `Unknown permission scope ${JSON.stringify(scope)}`,
      );
      return;
    }
    if (seen.has(scope)) {
      issues.add(`${path}/${i}`, `Duplicate scope "${scope}"`);
      return;
    }
    seen.add(scope);
    out.push(scope);
  });
  return out;
}

/**
 * Validates untrusted JSON into a `PluginManifest`, reporting every issue
 * with its path. Checks every invariant documented on `PluginManifest`
 * plus: unknown properties, the reserved `app`/`forsee` ids, supported
 * `apiVersion`, safe relative paths for `main`, panel entries and
 * contributed files, unique panel ids, valid regions and platforms,
 * well-formed `network:<host>` scopes, setting schemas, and that
 * `native.sidecar` is only requested by plugins that can run on desktop.
 */
export function validateManifest(
  json: unknown,
  options: ManifestValidationOptions = {},
): ValidationResult<PluginManifest> {
  const issues = new Issues();
  const m = issues.object('', json, MANIFEST_KEYS, 'a manifest object');
  if (!m) return { ok: false, issues: issues.list };

  if (m.$schema !== undefined) issues.string('/$schema', m.$schema, { max: MAX_URL_LENGTH });

  if (m.id === undefined) issues.add('/id', 'Required');
  else if (!isPluginIdSyntax(m.id)) {
    issues.add(
      '/id',
      'Expected lower-case dot-separated segments of letters, digits and single hyphens (for example "community.example-phrases")',
    );
  } else {
    const reserved = reservedIdReason(m.id, options.firstParty === true);
    if (reserved) issues.add('/id', reserved);
  }

  issues.string('/name', m.name, { min: 1, max: 100 });
  for (const key of ['version', 'minAppVersion'] as const) {
    if (issues.string(`/${key}`, m[key], { min: 1, max: MAX_VERSION_LENGTH })) {
      if (!isSemVer(m[key]))
        issues.add(`/${key}`, 'Expected a semantic version (MAJOR.MINOR.PATCH)');
    }
  }
  if (issues.number('/apiVersion', m.apiVersion, { integer: true })) {
    if (!SUPPORTED_API_VERSIONS.includes(m.apiVersion)) {
      issues.add(
        '/apiVersion',
        `Unsupported plugin API version ${m.apiVersion} (supported: ${SUPPORTED_API_VERSIONS.join(', ')})`,
      );
    }
  }
  issues.string('/description', m.description, { max: LIMITS.descriptionLength });
  issues.string('/author', m.author, { min: 1, max: LIMITS.labelLength });
  for (const key of ['authorUrl', 'fundingUrl'] as const) {
    issues.string(`/${key}`, m[key], {
      required: false,
      max: MAX_URL_LENGTH,
      pattern: URL_RE,
      patternMessage: 'Expected an http(s) URL',
    });
  }

  let platforms: readonly PluginPlatform[] | undefined;
  if (issues.array('/platforms', m.platforms, { required: false, min: 1, max: 3 })) {
    const seen = new Set<unknown>();
    m.platforms.forEach((platform, i) => {
      if (!PLUGIN_PLATFORMS.includes(platform as PluginPlatform)) {
        issues.add(`/platforms/${i}`, `Expected one of ${PLUGIN_PLATFORMS.join(', ')}`);
      } else if (seen.has(platform)) {
        issues.add(`/platforms/${i}`, `Duplicate platform "${String(platform)}"`);
      }
      seen.add(platform);
    });
    platforms = m.platforms as readonly PluginPlatform[];
  }

  if (m.main !== undefined) safePath(issues, '/main', m.main, ['.js', '.mjs']);

  if (issues.array('/panels', m.panels, { required: false, max: MAX_PANELS })) {
    const ids = new Set<string>();
    m.panels.forEach((panel, i) => {
      const p = `/panels/${i}`;
      const o = issues.object(p, panel, ['id', 'entry', 'region', 'title']);
      if (!o) return;
      if (
        issues.string(`${p}/id`, o.id, {
          min: 1,
          max: 64,
          pattern: PANEL_ID,
          patternMessage: 'Expected letters, digits, "_" and "-"',
        })
      ) {
        if (ids.has(o.id)) issues.add(`${p}/id`, `Duplicate panel id "${o.id}"`);
        ids.add(o.id);
      }
      safePath(issues, `${p}/entry`, o.entry, ['.html', '.htm']);
      if (!REGION_IDS.includes(o.region as (typeof REGION_IDS)[number])) {
        issues.add(`${p}/region`, `Expected one of ${REGION_IDS.join(', ')}`);
      }
      issues.string(`${p}/title`, o.title, { required: false, min: 1, max: 100 });
    });
  }

  if (m.contributes !== undefined) {
    const c = issues.object('/contributes', m.contributes, [...CONTRIBUTED_FILE_KINDS, 'settings']);
    if (c) {
      for (const kind of CONTRIBUTED_FILE_KINDS) {
        const files: unknown = c[kind];
        const p = `/contributes/${kind}`;
        if (!issues.array(p, files, { required: false, max: MAX_CONTRIBUTED_FILES })) continue;
        const seen = new Set<unknown>();
        files.forEach((file, i) => {
          safePath(issues, `${p}/${i}`, file, ['.json']);
          if (seen.has(file)) issues.add(`${p}/${i}`, 'Duplicate file');
          seen.add(file);
        });
      }
      if (c.settings !== undefined) {
        const settings = validateSettingFieldsJson(c.settings);
        if (!settings.ok) issues.addAll('/contributes/settings', settings.issues);
      }
    }
  }

  const permissions = scopeList(issues, '/permissions', m.permissions);
  const optional = scopeList(issues, '/optionalPermissions', m.optionalPermissions);
  optional.forEach((scope) => {
    if (permissions.includes(scope)) {
      const index = (m.optionalPermissions as unknown[]).indexOf(scope);
      issues.add(
        `/optionalPermissions/${index}`,
        `"${scope}" is listed in both permissions and optionalPermissions`,
      );
    }
  });
  if (
    (permissions.includes('native.sidecar') || optional.includes('native.sidecar')) &&
    platforms !== undefined &&
    !platforms.includes('desktop')
  ) {
    issues.add('/platforms', 'native.sidecar is desktop-only, but platforms excludes desktop');
  }

  return issues.result(() => json as PluginManifest);
}

/** Trust tier implied by a manifest: panels → `custom-ui`, else `main` → `logic`, else `declarative`. */
export function trustTierOf(manifest: PluginManifest): TrustTier {
  if (manifest.panels !== undefined && manifest.panels.length > 0) return 'custom-ui';
  if (manifest.main !== undefined) return 'logic';
  return 'declarative';
}

/** Platform family the app is running as, from the host's platform info. */
export function pluginPlatformOf(platform: Pick<PlatformInfo, 'shell' | 'os'>): PluginPlatform {
  switch (platform.shell) {
    case 'electron':
      return 'desktop';
    case 'capacitor':
      return 'mobile';
    case 'web':
    case 'memory':
      return 'web';
  }
}

/** Checks `minAppVersion` and `platforms` against the running app. */
export function checkCompatibility(
  manifest: PluginManifest,
  target: CompatibilityTarget,
): CompatibilityResult {
  const reasons: string[] = [];
  const required = parseSemVer(manifest.minAppVersion);
  const running = parseSemVer(target.appVersion);
  if (!required) {
    reasons.push(`Its minimum app version "${manifest.minAppVersion}" is not a valid version.`);
  } else if (!running) {
    reasons.push(`The app version "${target.appVersion}" is not a valid version.`);
  } else if (compareSemVer(running, required) < 0) {
    reasons.push(
      `It needs Forsee ${manifest.minAppVersion} or later; this is ${target.appVersion}. Update the app to use it.`,
    );
  }
  if (manifest.platforms !== undefined && !manifest.platforms.includes(target.platform)) {
    reasons.push(`It runs only on ${manifest.platforms.join(' and ')}, not on ${target.platform}.`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
