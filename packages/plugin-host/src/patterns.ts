/**
 * Grammars shared by the manifest validator, the contribution validators,
 * the plugin API's argument checks and the published JSON Schema. Each is a
 * regular-expression source string (JSON Schema `pattern` form) plus the
 * compiled `RegExp`.
 */

/** One plugin id segment: lower-case letters and digits, single inner hyphens. */
const ID_SEGMENT = '[a-z0-9]+(?:-[a-z0-9]+)*';

/** Plugin id: dot-separated segments, for example `community.example-phrases`. */
export const PLUGIN_ID_PATTERN = `^${ID_SEGMENT}(?:\\.${ID_SEGMENT})*$`;
export const PLUGIN_ID = new RegExp(PLUGIN_ID_PATTERN);
export const MAX_PLUGIN_ID_LENGTH = 100;

/** First segment reserved for first-party plugins. */
export const FIRST_PARTY_ID_PREFIX = 'forsee';
/** First segments no plugin may use: `app` is the app's settings and command owner. */
export const RESERVED_ID_SEGMENTS: readonly string[] = ['app'];
/** Whole ids no plugin may use: command sources and owners with special meaning. */
export const RESERVED_IDS: readonly string[] = ['app', 'keyboard', 'forsee'];

/**
 * Local id inside a plugin (panel id, contribution name, setting-free ids):
 * starts with a letter or digit, then letters, digits, `_`, `-` or `.`; no
 * slashes, so `<pluginId>/<localId>` is unambiguous, and no `..`.
 */
export const LOCAL_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$';
export const LOCAL_ID = new RegExp(LOCAL_ID_PATTERN);

/** Panel id in a manifest. */
export const PANEL_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$';
export const PANEL_ID = new RegExp(PANEL_ID_PATTERN);

/**
 * Safe relative path inside a plugin folder: `/`-separated segments, each
 * starting with a letter, digit, `_` or `-` (so no `.`/`..` segments and no
 * hidden files), made of letters, digits, `_`, `-` and `.`. This excludes
 * absolute paths, backslashes, URL schemes (`:`), query and fragment
 * characters, percent-encoding, whitespace and empty segments.
 */
export const SAFE_PATH_PATTERN = '^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$';
export const SAFE_PATH = new RegExp(SAFE_PATH_PATTERN);
export const MAX_PATH_LENGTH = 256;

/** Whether `path` is a safe relative path inside a plugin folder. */
export function isSafeRelativePath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= MAX_PATH_LENGTH && SAFE_PATH.test(path);
}

/** One DNS label. */
const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** Lower-case DNS name: no scheme, port, path, wildcard or trailing dot. */
export const HOST_PATTERN = `^${DNS_LABEL}(?:\\.${DNS_LABEL})*$`;
export const HOST = new RegExp(HOST_PATTERN);
export const MAX_HOST_LENGTH = 253;

/** `network:<host>` permission scope. */
export const NETWORK_SCOPE_PATTERN = `^network:${DNS_LABEL}(?:\\.${DNS_LABEL})*$`;

/** Whether `host` is a valid host for a `network:<host>` scope. */
export function isValidHost(host: string): boolean {
  return host.length <= MAX_HOST_LENGTH && HOST.test(host);
}

/** http(s) URL with no whitespace. */
export const URL_PATTERN = '^https?://[^\\s/?#]+[^\\s]*$';
export const URL_RE = new RegExp(URL_PATTERN);
export const MAX_URL_LENGTH = 2048;

/** Setting key (`SettingField.key`). */
export const SETTING_KEY_PATTERN = '^[A-Za-z0-9_.-]+$';
export const SETTING_KEY = new RegExp(SETTING_KEY_PATTERN);
export const MAX_SETTING_KEY_LENGTH = 64;

/** BCP 47-shaped locale tag (`en`, `en-GB`, `zh-Hant-TW`). */
export const LOCALE_PATTERN = '^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$';
export const LOCALE = new RegExp(LOCALE_PATTERN);

/** Context store key (`ContextStore` accepts the same grammar). */
export const CONTEXT_KEY = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/** Command id: dot or slash separated segments of letters, digits, `_` and `-`. */
export const COMMAND_ID = /^[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$/;
