import { FIXED_PERMISSION_SCOPES, REGION_IDS } from '@forsee/plugin-api';
import { LIMITS } from './guards';
import { CONTRIBUTED_FILE_KINDS, PLUGIN_PLATFORMS, SUPPORTED_API_VERSIONS } from './manifest';
import {
  MAX_PATH_LENGTH,
  MAX_PLUGIN_ID_LENGTH,
  MAX_SETTING_KEY_LENGTH,
  MAX_URL_LENGTH,
  NETWORK_SCOPE_PATTERN,
  PANEL_ID_PATTERN,
  PLUGIN_ID_PATTERN,
  SAFE_PATH_PATTERN,
  SETTING_KEY_PATTERN,
  URL_PATTERN,
} from './patterns';
import { MAX_VERSION_LENGTH, SEMVER_PATTERN } from './semver';

/**
 * JSON Schema (draft 2020-12) for `manifest.json`, for editors and the
 * community directory's CI. It is built from the same patterns as
 * `validateManifest`, and tests keep the two in step. The schema covers the
 * structure; a few cross-field rules are checked only by `validateManifest`
 * (listed under `$comment`).
 */
export const PLUGIN_MANIFEST_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://forsee.app/schemas/plugin-manifest.schema.json',
  title: 'Forsee plugin manifest',
  $comment:
    'Also checked by the plugin host: "forsee." ids only for first-party plugins and "app"/"keyboard" ids never; ' +
    'scopes not in both permissions and optionalPermissions; unique panel ids; network hosts at most 253 characters; ' +
    'native.sidecar only with a desktop platform; setting defaults valid for their schema.',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'version', 'apiVersion', 'minAppVersion', 'description', 'author'],
  properties: {
    $schema: { type: 'string', maxLength: MAX_URL_LENGTH },
    id: { type: 'string', maxLength: MAX_PLUGIN_ID_LENGTH, pattern: PLUGIN_ID_PATTERN },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    version: { $ref: '#/$defs/semver' },
    apiVersion: { enum: [...SUPPORTED_API_VERSIONS] },
    minAppVersion: { $ref: '#/$defs/semver' },
    description: { type: 'string', maxLength: LIMITS.descriptionLength },
    author: { type: 'string', minLength: 1, maxLength: LIMITS.labelLength },
    authorUrl: { $ref: '#/$defs/url' },
    fundingUrl: { $ref: '#/$defs/url' },
    platforms: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      items: { enum: [...PLUGIN_PLATFORMS] },
    },
    main: { $ref: '#/$defs/path', pattern: '\\.(?:[jJ][sS]|[mM][jJ][sS])$' },
    panels: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'entry', 'region'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 64, pattern: PANEL_ID_PATTERN },
          entry: { $ref: '#/$defs/path', pattern: '\\.[hH][tT][mM][lL]?$' },
          region: { enum: [...REGION_IDS] },
          title: { type: 'string', minLength: 1, maxLength: 100 },
        },
      },
    },
    contributes: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...Object.fromEntries(
          CONTRIBUTED_FILE_KINDS.map((kind) => [
            kind,
            {
              type: 'array',
              maxItems: 64,
              uniqueItems: true,
              items: { $ref: '#/$defs/path', pattern: '\\.[jJ][sS][oO][nN]$' },
            },
          ]),
        ),
        settings: {
          type: 'array',
          maxItems: LIMITS.settingFields,
          items: { $ref: '#/$defs/settingField' },
        },
      },
    },
    permissions: { $ref: '#/$defs/scopes' },
    optionalPermissions: { $ref: '#/$defs/scopes' },
  },
  $defs: {
    semver: { type: 'string', maxLength: MAX_VERSION_LENGTH, pattern: SEMVER_PATTERN },
    url: { type: 'string', maxLength: MAX_URL_LENGTH, pattern: URL_PATTERN },
    path: { type: 'string', minLength: 1, maxLength: MAX_PATH_LENGTH, pattern: SAFE_PATH_PATTERN },
    scope: {
      anyOf: [
        { enum: [...FIXED_PERMISSION_SCOPES] },
        { type: 'string', maxLength: 8 + 253, pattern: NETWORK_SCOPE_PATTERN },
      ],
    },
    scopes: { type: 'array', maxItems: 64, uniqueItems: true, items: { $ref: '#/$defs/scope' } },
    settingValue: {
      anyOf: [
        { type: 'string', maxLength: LIMITS.textLength },
        { type: 'number' },
        { type: 'boolean' },
      ],
    },
    settingField: {
      type: 'object',
      additionalProperties: false,
      required: ['key', 'label', 'type', 'default'],
      properties: {
        key: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_SETTING_KEY_LENGTH,
          pattern: SETTING_KEY_PATTERN,
        },
        label: { type: 'string', minLength: 1, maxLength: LIMITS.labelLength },
        type: { enum: ['string', 'number', 'boolean', 'select', 'range'] },
        description: { type: 'string', maxLength: LIMITS.descriptionLength },
        default: { $ref: '#/$defs/settingValue' },
        options: {
          type: 'array',
          maxItems: 200,
          items: {
            anyOf: [
              { type: 'string', minLength: 1, maxLength: LIMITS.labelLength },
              {
                type: 'object',
                additionalProperties: false,
                required: ['label', 'value'],
                properties: {
                  label: { type: 'string', minLength: 1, maxLength: LIMITS.labelLength },
                  value: { $ref: '#/$defs/settingValue' },
                },
              },
            ],
          },
        },
        min: { type: 'number' },
        max: { type: 'number' },
        step: { type: 'number' },
      },
    },
  },
} as const;
