import type { PluginManifest } from '@forsee/plugin-api';
import { describe, expect, it } from 'vitest';
import { checkCompatibility, pluginPlatformOf, trustTierOf, validateManifest } from './manifest';
import { PLUGIN_MANIFEST_JSON_SCHEMA } from './manifest-schema';
import { compareSemVer, parseSemVer } from './semver';

/** The plan's sample manifest (section 6), with the prose placeholders filled in. */
const PLAN_SAMPLE = {
  id: 'community.example-phrases',
  name: 'Example phrases',
  version: '1.2.0',
  apiVersion: 1,
  minAppVersion: '1.0.0',
  description: 'Phrases for examples.',
  author: 'A. Author',
  authorUrl: 'https://example.com',
  fundingUrl: 'https://example.com/fund',
  platforms: ['desktop', 'mobile'],
  main: 'main.js',
  panels: [{ id: 'picker', entry: 'panel.html', region: 'side' }],
  contributes: {
    layouts: ['layouts/compact.json'],
    phraseSets: ['phrases/greetings.json'],
    settings: [
      {
        key: 'tone',
        label: 'Tone',
        type: 'select',
        default: 'casual',
        options: ['casual', 'formal'],
      },
    ],
  },
  permissions: ['composition.read', 'speech.output'],
  optionalPermissions: ['history.read'],
};

const MINIMAL = {
  id: 'community.minimal',
  name: 'Minimal',
  version: '0.1.0',
  apiVersion: 1,
  minAppVersion: '1.0.0',
  description: '',
  author: 'Someone',
};

function with_(patch: Record<string, unknown>, base: Record<string, unknown> = MINIMAL): unknown {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------- a tiny JSON Schema evaluator

type Schema = Record<string, unknown>;

/**
 * Evaluates the subset of JSON Schema 2020-12 the manifest schema uses
 * (type, enum, const, properties, required, additionalProperties, items,
 * minItems, maxItems, uniqueItems, minLength, maxLength, pattern, anyOf,
 * $ref to #/$defs). Enough to keep the published schema honest.
 */
function schemaAccepts(schema: Schema, value: unknown, root: Schema = schema): boolean {
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/$defs/', '');
    const target = (root.$defs as Record<string, Schema>)[name];
    if (!target || !schemaAccepts(target, value, root)) return false;
  }
  if (schema.enum !== undefined && !(schema.enum as unknown[]).includes(value)) return false;
  if (
    schema.anyOf !== undefined &&
    !(schema.anyOf as Schema[]).some((s) => schemaAccepts(s, value, root))
  ) {
    return false;
  }
  const type = schema.type;
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  } else if (type === 'array') {
    if (!Array.isArray(value)) return false;
  } else if (type === 'string') {
    if (typeof value !== 'string') return false;
  } else if (type === 'number') {
    if (typeof value !== 'number') return false;
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') return false;
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      return false;
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
    if (schema.uniqueItems === true) {
      const seen = value.map((v) => JSON.stringify(v));
      if (new Set(seen).size !== seen.length) return false;
    }
    if (
      schema.items !== undefined &&
      !value.every((v) => schemaAccepts(schema.items as Schema, v, root))
    ) {
      return false;
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) if (!(key in obj)) return false;
    for (const [key, v] of Object.entries(obj)) {
      const prop = props[key];
      if (prop) {
        if (!schemaAccepts(prop, v, root)) return false;
      } else if (schema.additionalProperties === false) {
        return false;
      }
    }
  }
  return true;
}

const SCHEMA = PLUGIN_MANIFEST_JSON_SCHEMA as unknown as Schema;

// ---------------------------------------------------------------- cases

interface Case {
  readonly name: string;
  readonly json: unknown;
  /** Issue path expected (prefix match) when invalid. */
  readonly path?: string;
  /** For invalid cases the schema cannot express (cross-field rules). */
  readonly schemaOnlyStructural?: true;
}

const VALID: readonly Case[] = [
  { name: 'the plan sample', json: PLAN_SAMPLE },
  { name: 'a minimal declarative manifest', json: MINIMAL },
  { name: 'a single-segment id', json: with_({ id: 'phrases' }) },
  { name: 'a prerelease version', json: with_({ version: '1.0.0-beta.2+build.5' }) },
  { name: 'a network scope', json: with_({ permissions: ['network:api.example.com'] }) },
  {
    name: 'every fixed scope',
    json: with_({
      permissions: [
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
      ],
    }),
  },
  {
    name: 'a desktop driver with native.sidecar',
    json: with_({ platforms: ['desktop'], permissions: ['native.sidecar'] }),
  },
  {
    name: 'nested contribution paths',
    json: with_({ contributes: { themes: ['a/b-c/d_e.v2.json'], vocabularies: ['words.JSON'] } }),
  },
  {
    name: 'a $schema property',
    json: with_({ $schema: 'https://forsee.app/schemas/plugin-manifest.schema.json' }),
  },
  { name: 'a module entry', json: with_({ main: 'dist/main.mjs' }) },
  {
    name: 'panels in every region',
    json: with_({
      panels: ['composition', 'quickfire', 'predictions', 'main', 'side'].map((region, i) => ({
        id: `p${i}`,
        entry: `p${i}.htm`,
        region,
        title: 'P',
      })),
    }),
  },
];

const INVALID: readonly Case[] = [
  { name: 'not an object', json: [], path: '' },
  { name: 'null', json: null, path: '' },
  { name: 'missing id', json: with_({ id: undefined }), path: '/id' },
  { name: 'upper-case id', json: with_({ id: 'Community.Thing' }), path: '/id' },
  { name: 'id with a slash', json: with_({ id: 'community/thing' }), path: '/id' },
  { name: 'id with an empty segment', json: with_({ id: 'community..thing' }), path: '/id' },
  { name: 'id with a leading hyphen', json: with_({ id: '-community.thing' }), path: '/id' },
  { name: 'id with a path trick', json: with_({ id: '../evil' }), path: '/id' },
  { name: 'too long id', json: with_({ id: `a.${'b'.repeat(120)}` }), path: '/id' },
  {
    name: 'reserved forsee prefix',
    json: with_({ id: 'forsee.phrases' }),
    path: '/id',
    schemaOnlyStructural: true,
  },
  {
    name: 'reserved app id',
    json: with_({ id: 'app.thing' }),
    path: '/id',
    schemaOnlyStructural: true,
  },
  {
    name: 'reserved keyboard id',
    json: with_({ id: 'keyboard' }),
    path: '/id',
    schemaOnlyStructural: true,
  },
  { name: 'missing name', json: with_({ name: undefined }), path: '/name' },
  { name: 'empty name', json: with_({ name: '' }), path: '/name' },
  { name: 'missing description', json: with_({ description: undefined }), path: '/description' },
  { name: 'missing author', json: with_({ author: undefined }), path: '/author' },
  { name: 'non-semver version', json: with_({ version: '1.0' }), path: '/version' },
  { name: 'leading zero version', json: with_({ version: '01.0.0' }), path: '/version' },
  {
    name: 'non-semver minAppVersion',
    json: with_({ minAppVersion: 'latest' }),
    path: '/minAppVersion',
  },
  { name: 'numeric version', json: with_({ version: 1 }), path: '/version' },
  { name: 'unsupported apiVersion', json: with_({ apiVersion: 2 }), path: '/apiVersion' },
  { name: 'string apiVersion', json: with_({ apiVersion: '1' }), path: '/apiVersion' },
  {
    name: 'javascript: authorUrl',
    json: with_({ authorUrl: 'javascript:alert(1)' }),
    path: '/authorUrl',
  },
  { name: 'unknown property', json: with_({ homepage: 'https://x.y' }), path: '/homepage' },
  { name: 'unknown platform', json: with_({ platforms: ['tv'] }), path: '/platforms/0' },
  { name: 'empty platforms', json: with_({ platforms: [] }), path: '/platforms' },
  { name: 'duplicate platform', json: with_({ platforms: ['web', 'web'] }), path: '/platforms/1' },
  { name: 'absolute main', json: with_({ main: '/main.js' }), path: '/main' },
  { name: 'parent main', json: with_({ main: '../main.js' }), path: '/main' },
  { name: 'nested parent main', json: with_({ main: 'lib/../../main.js' }), path: '/main' },
  { name: 'backslash main', json: with_({ main: 'lib\\main.js' }), path: '/main' },
  { name: 'URL main', json: with_({ main: 'https://evil.example/main.js' }), path: '/main' },
  { name: 'data URL main', json: with_({ main: 'data:text/javascript,alert(1)' }), path: '/main' },
  { name: 'drive letter main', json: with_({ main: 'C:/main.js' }), path: '/main' },
  { name: 'hidden main', json: with_({ main: '.hidden/main.js' }), path: '/main' },
  { name: 'non-js main', json: with_({ main: 'main.ts' }), path: '/main' },
  { name: 'empty main', json: with_({ main: '' }), path: '/main' },
  { name: 'panels not an array', json: with_({ panels: {} }), path: '/panels' },
  {
    name: 'panel without entry',
    json: with_({ panels: [{ id: 'a', region: 'side' }] }),
    path: '/panels/0/entry',
  },
  {
    name: 'panel entry escaping',
    json: with_({ panels: [{ id: 'a', entry: '../a.html', region: 'side' }] }),
    path: '/panels/0/entry',
  },
  {
    name: 'panel entry not html',
    json: with_({ panels: [{ id: 'a', entry: 'a.js', region: 'side' }] }),
    path: '/panels/0/entry',
  },
  {
    name: 'panel with a bad region',
    json: with_({ panels: [{ id: 'a', entry: 'a.html', region: 'top' }] }),
    path: '/panels/0/region',
  },
  {
    name: 'panel id with a slash',
    json: with_({ panels: [{ id: 'a/b', entry: 'a.html', region: 'side' }] }),
    path: '/panels/0/id',
  },
  {
    name: 'duplicate panel ids',
    json: with_({
      panels: [
        { id: 'a', entry: 'a.html', region: 'side' },
        { id: 'a', entry: 'b.html', region: 'main' },
      ],
    }),
    path: '/panels/1/id',
    schemaOnlyStructural: true,
  },
  {
    name: 'unknown panel property',
    json: with_({ panels: [{ id: 'a', entry: 'a.html', region: 'side', onload: 'x' }] }),
    path: '/panels/0/onload',
  },
  {
    name: 'contributed file escaping',
    json: with_({ contributes: { layouts: ['../../settings.json'] } }),
    path: '/contributes/layouts/0',
  },
  {
    name: 'contributed file absolute',
    json: with_({ contributes: { themes: ['/etc/passwd.json'] } }),
    path: '/contributes/themes/0',
  },
  {
    name: 'contributed file not json',
    json: with_({ contributes: { phraseSets: ['phrases.txt'] } }),
    path: '/contributes/phraseSets/0',
  },
  {
    name: 'contributed file with a scheme',
    json: with_({ contributes: { vocabularies: ['file:words.json'] } }),
    path: '/contributes/vocabularies/0',
  },
  {
    name: 'duplicate contributed file',
    json: with_({ contributes: { layouts: ['a.json', 'a.json'] } }),
    path: '/contributes/layouts/1',
  },
  {
    name: 'unknown contribution kind',
    json: with_({ contributes: { scripts: ['a.json'] } }),
    path: '/contributes/scripts',
  },
  {
    name: 'setting without label',
    json: with_({ contributes: { settings: [{ key: 'a', type: 'string', default: '' }] } }),
    path: '/contributes/settings/0/label',
  },
  {
    name: 'setting with a bad type',
    json: with_({
      contributes: { settings: [{ key: 'a', label: 'A', type: 'colour', default: '' }] },
    }),
    path: '/contributes/settings/0/type',
  },
  {
    name: 'setting with an invalid default',
    json: with_({
      contributes: {
        settings: [{ key: 'a', label: 'A', type: 'select', default: 'x', options: ['y'] }],
      },
    }),
    path: '/contributes/settings/0',
    schemaOnlyStructural: true,
  },
  {
    name: 'unknown permission',
    json: with_({ permissions: ['everything'] }),
    path: '/permissions/0',
  },
  {
    name: 'network scope with a scheme',
    json: with_({ permissions: ['network:https://api.example.com'] }),
    path: '/permissions/0',
  },
  {
    name: 'network scope with a port',
    json: with_({ permissions: ['network:api.example.com:443'] }),
    path: '/permissions/0',
  },
  {
    name: 'network scope with a path',
    json: with_({ permissions: ['network:api.example.com/v1'] }),
    path: '/permissions/0',
  },
  {
    name: 'network scope with a wildcard',
    json: with_({ permissions: ['network:*.example.com'] }),
    path: '/permissions/0',
  },
  {
    name: 'network scope upper-case',
    json: with_({ permissions: ['network:API.example.com'] }),
    path: '/permissions/0',
  },
  {
    name: 'empty network scope',
    json: with_({ permissions: ['network:'] }),
    path: '/permissions/0',
  },
  {
    name: 'duplicate permission',
    json: with_({ permissions: ['camera', 'camera'] }),
    path: '/permissions/1',
  },
  {
    name: 'scope in both lists',
    json: with_({ permissions: ['camera'], optionalPermissions: ['camera'] }),
    path: '/optionalPermissions/0',
    schemaOnlyStructural: true,
  },
  {
    name: 'native.sidecar without desktop',
    json: with_({ platforms: ['web'], permissions: ['native.sidecar'] }),
    path: '/platforms',
    schemaOnlyStructural: true,
  },
];

describe('validateManifest', () => {
  it.each(VALID)('accepts $name', ({ json }) => {
    const result = validateManifest(json);
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it.each(INVALID)('rejects $name', ({ json, path }) => {
    const result = validateManifest(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path)).toContain(path);
    for (const issue of result.issues) expect(issue.message).not.toBe('');
  });

  it('reports every issue at once, with paths', () => {
    const result = validateManifest({
      id: 'Bad Id',
      name: '',
      version: 'x',
      apiVersion: 9,
      minAppVersion: '1',
      description: 3,
      author: 'a',
      main: '../x.js',
      permissions: ['nope'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path).sort()).toEqual(
      [
        '/apiVersion',
        '/description',
        '/id',
        '/main',
        '/minAppVersion',
        '/name',
        '/permissions/0',
        '/version',
      ].sort(),
    );
  });

  it('allows the forsee prefix for first-party manifests only', () => {
    const manifest = with_({ id: 'forsee.keyboard' });
    expect(validateManifest(manifest).ok).toBe(false);
    expect(validateManifest(manifest, { firstParty: true }).ok).toBe(true);
    // app stays reserved even for first-party code.
    expect(validateManifest(with_({ id: 'app.x' }), { firstParty: true }).ok).toBe(false);
  });

  it('returns the manifest unchanged when valid', () => {
    const result = validateManifest(PLAN_SAMPLE);
    expect(result.ok && result.value).toBe(PLAN_SAMPLE);
  });
});

describe('the published JSON Schema', () => {
  it('is a draft 2020-12 schema', () => {
    expect(SCHEMA.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it.each(VALID)('accepts $name like the validator', ({ json }) => {
    expect(schemaAccepts(SCHEMA, json)).toBe(true);
  });

  it.each(INVALID.filter((c) => !c.schemaOnlyStructural))(
    'rejects $name like the validator',
    ({ json }) => {
      expect(schemaAccepts(SCHEMA, json)).toBe(false);
    },
  );

  it.each(INVALID.filter((c) => c.schemaOnlyStructural))(
    'accepts $name structurally (a cross-field rule only the validator checks)',
    ({ json }) => {
      expect(schemaAccepts(SCHEMA, json)).toBe(true);
    },
  );

  it('lists every manifest property the validator knows', () => {
    const properties = Object.keys(SCHEMA.properties as object).sort();
    const sample: Required<PluginManifest> = {
      ...(PLAN_SAMPLE as unknown as PluginManifest),
      panels: [],
      contributes: {},
      permissions: [],
      optionalPermissions: [],
      platforms: [],
      main: 'a.js',
      authorUrl: '',
      fundingUrl: '',
    };
    expect(properties).toEqual(['$schema', ...Object.keys(sample)].sort());
  });
});

describe('trustTierOf', () => {
  const base = MINIMAL as PluginManifest;
  it.each([
    ['declarative', base],
    ['declarative', { ...base, panels: [] }],
    ['logic', { ...base, main: 'main.js' }],
    ['custom-ui', { ...base, panels: [{ id: 'p', entry: 'p.html', region: 'side' as const }] }],
    [
      'custom-ui',
      { ...base, main: 'main.js', panels: [{ id: 'p', entry: 'p.html', region: 'side' as const }] },
    ],
  ] as const)('derives %s', (tier, manifest) => {
    expect(trustTierOf(manifest)).toBe(tier);
  });
});

describe('compatibility', () => {
  const manifest = { ...(MINIMAL as PluginManifest), minAppVersion: '1.2.0' };

  it('accepts an app at or above minAppVersion on any platform when platforms is omitted', () => {
    expect(checkCompatibility(manifest, { appVersion: '1.2.0', platform: 'web' })).toEqual({
      ok: true,
    });
    expect(checkCompatibility(manifest, { appVersion: '2.0.0', platform: 'mobile' })).toEqual({
      ok: true,
    });
  });

  it('refuses an older app with a reason that names both versions', () => {
    const result = checkCompatibility(manifest, { appVersion: '1.1.9', platform: 'web' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons[0]).toContain('1.2.0');
    expect(result.reasons[0]).toContain('1.1.9');
  });

  it('treats a prerelease of the required version as older', () => {
    expect(checkCompatibility(manifest, { appVersion: '1.2.0-rc.1', platform: 'web' }).ok).toBe(
      false,
    );
  });

  it('refuses another platform, giving both', () => {
    const result = checkCompatibility(
      { ...manifest, platforms: ['desktop'] },
      { appVersion: '9.0.0', platform: 'mobile' },
    );
    expect(result).toEqual({ ok: false, reasons: ['It runs only on desktop, not on mobile.'] });
  });

  it('collects both reasons', () => {
    const result = checkCompatibility(
      { ...manifest, platforms: ['desktop'] },
      { appVersion: '0.1.0', platform: 'web' },
    );
    expect(result.ok ? 0 : result.reasons.length).toBe(2);
  });

  it('maps shells to platforms', () => {
    expect(pluginPlatformOf({ shell: 'electron', os: 'linux' })).toBe('desktop');
    expect(pluginPlatformOf({ shell: 'capacitor', os: 'ios' })).toBe('mobile');
    expect(pluginPlatformOf({ shell: 'web', os: 'macos' })).toBe('web');
  });
});

describe('semver', () => {
  it.each([
    ['1.0.0', '1.0.1', -1],
    ['1.10.0', '1.9.0', 1],
    ['1.0.0-alpha', '1.0.0', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1],
    ['1.0.0+build', '1.0.0', 0],
  ])('compares %s with %s', (a, b, expected) => {
    const pa = parseSemVer(a);
    const pb = parseSemVer(b);
    expect(pa && pb && compareSemVer(pa, pb)).toBe(expected);
  });

  it('rejects huge or malformed versions', () => {
    expect(parseSemVer('99999999999999999999.0.0')).toBeNull();
    expect(parseSemVer('1.0.0-')).toBeNull();
    expect(parseSemVer(`1.0.0-${'a'.repeat(100)}`)).toBeNull();
  });
});
