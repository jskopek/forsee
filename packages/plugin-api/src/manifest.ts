import type { RegionId } from './regions';
import type { SettingField } from './settings';

/**
 * Version of the plugin API described by this package. A manifest's
 * `apiVersion` must equal this value (or a version the host still supports).
 * Bumped only for breaking changes; additive changes keep the number.
 */
export const API_VERSION = 1;

/** How settled the plugin API is: `provisional` (may change) or `stable`. */
export type ApiStability = 'provisional' | 'stable';

/**
 * The plugin API is **provisional** until the first end-to-end release of
 * Forsee: until then it may change, including incompatibly, without a change
 * to `API_VERSION`. See `packages/plugin-api/README.md`.
 */
export const API_STABILITY: ApiStability = 'provisional';

/**
 * Permission scopes a plugin can request (plan section 6).
 *
 * - `composition.read` / `composition.write`: see or change the text being written.
 * - `history.read`: past conversations.
 * - `speech.output`: speak aloud.
 * - `gaze.read`: raw gaze samples (selection `activate` events do not need it).
 * - `camera`, `microphone`: device streams, mediated by the host.
 * - `network:<host>`: requests to one named host, for example `network:api.example.com`.
 *   The host part is a lower-case DNS name with no scheme, port, path or wildcard.
 * - `lm.read` / `lm.write`: the user's personal language data.
 * - `inference`: run a model through the host's inference service.
 * - `native.sidecar`: launch a driver process (desktop only).
 * - `context.read` / `context.write`: read or write the shared context store
 *   (see Decisions in docs/ARCHITECTURE.md; the plan says "any prediction
 *   provider with permission can read them" without naming the scope).
 *
 * A plugin's own private storage and settings need no permission.
 */
export type PermissionScope = FixedPermissionScope | NetworkPermissionScope;

/** Every permission scope that is not parameterised. */
export type FixedPermissionScope =
  | 'composition.read'
  | 'composition.write'
  | 'history.read'
  | 'speech.output'
  | 'gaze.read'
  | 'camera'
  | 'microphone'
  | 'lm.read'
  | 'lm.write'
  | 'inference'
  | 'native.sidecar'
  | 'context.read'
  | 'context.write';

/** A network permission for exactly one host: `network:<host>`. */
export type NetworkPermissionScope = `network:${string}`;

/** All non-parameterised scopes, for validators and consent screens. */
export const FIXED_PERMISSION_SCOPES: readonly FixedPermissionScope[] = [
  'composition.read',
  'composition.write',
  'history.read',
  'speech.output',
  'gaze.read',
  'camera',
  'microphone',
  'lm.read',
  'lm.write',
  'inference',
  'native.sidecar',
  'context.read',
  'context.write',
];

/** Prefix of a network permission scope. */
export const NETWORK_PERMISSION_PREFIX = 'network:';

/**
 * Scopes that are never granted silently: the user must consent at first use
 * even if they consented at install (plan section 6).
 */
export const SENSITIVE_PERMISSION_SCOPES: readonly FixedPermissionScope[] = [
  'history.read',
  'camera',
  'microphone',
  'gaze.read',
  'lm.read',
];

/**
 * Trust tier of a plugin, derived from its manifest by the plugin host:
 *
 * - `declarative`: no `main` and no `panels`; JSON contributions only. Safe everywhere.
 * - `logic`: has `main`; runs in a sandboxed frame + worker, talks over RPC.
 * - `custom-ui`: has `panels`; each panel renders in a sandboxed, non-interactive frame.
 *
 * First-party plugins are a separate *runtime* choice (they run in the main
 * context) but still declare the tier their manifest implies.
 */
export type TrustTier = 'declarative' | 'logic' | 'custom-ui';

/** Platform families a plugin can run on. */
export type PluginPlatform = 'desktop' | 'mobile' | 'web';

/** A panel the plugin renders in a sandboxed frame inside a screen region. */
export interface ManifestPanel {
  /** Unique within the plugin. The global panel id is `<pluginId>/<id>`. */
  readonly id: string;
  /** HTML entry, relative to the plugin folder. */
  readonly entry: string;
  /** Region the panel is placed in by default. The user's profile can move it. */
  readonly region: RegionId;
  /** Human-readable title shown in panel pickers. Defaults to the plugin name. */
  readonly title?: string;
}

/**
 * Declarative contributions listed in the manifest. File paths are relative to
 * the plugin folder, use `/` separators and must not escape the folder.
 */
export interface ManifestContributions {
  /** Layout JSON files (`LayoutDefinition`). */
  readonly layouts?: readonly string[];
  /** Theme JSON files (`ThemeDefinition`). */
  readonly themes?: readonly string[];
  /** Phrase set JSON files (`PhraseSet`). */
  readonly phraseSets?: readonly string[];
  /** Vocabulary JSON files (`Vocabulary`). */
  readonly vocabularies?: readonly string[];
  /** Setting fields, registered under the plugin's id as namespace. */
  readonly settings?: readonly SettingField[];
}

/**
 * The plugin manifest (`manifest.json` at the plugin folder root), exactly as
 * sketched in plan section 6.
 *
 * Invariants checked by the plugin host's validator:
 * - `id` is lower-case, dot-separated segments of `[a-z0-9-]` (for example
 *   `community.example-phrases`); `forsee.*` is reserved for first-party plugins.
 * - `version` and `minAppVersion` are semantic versions (`MAJOR.MINOR.PATCH`).
 * - Every scope in `optionalPermissions` is absent from `permissions`.
 */
export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** Plugin API version the plugin was written against; see `API_VERSION`. */
  readonly apiVersion: number;
  readonly minAppVersion: string;
  readonly description: string;
  readonly author: string;
  readonly authorUrl?: string;
  readonly fundingUrl?: string;
  /** Platforms the plugin supports. Omitted means all. Driver plugins say `["desktop"]`. */
  readonly platforms?: readonly PluginPlatform[];
  /** Optional logic entry (JavaScript module), relative to the plugin folder. */
  readonly main?: string;
  readonly panels?: readonly ManifestPanel[];
  readonly contributes?: ManifestContributions;
  /** Scopes requested at install. */
  readonly permissions?: readonly PermissionScope[];
  /** Scopes requested only when first used; the plugin must cope with refusal. */
  readonly optionalPermissions?: readonly PermissionScope[];
}
