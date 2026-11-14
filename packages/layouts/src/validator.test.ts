/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- mutation table over untyped JSON */
import { describe, expect, it } from 'vitest';
import { BUILTIN_LAYOUTS, LAYOUT_JSON_SCHEMA } from './catalogue';
import { matchesSchema } from './json-schema-check';
import { validateLayout } from './validator';

type Json = Record<string, any>;

function base(): Json {
  return {
    schemaVersion: 1,
    id: 'test/layout',
    name: 'Test',
    family: 'precise',
    locale: 'en-GB',
    initialPage: 'main',
    pages: [
      {
        id: 'main',
        name: 'Main',
        rows: [
          {
            keys: [
              {
                id: 'k-a',
                label: 'a',
                action: { command: 'composition.insert', args: { text: 'a' } },
              },
              { id: 'pad', width: 0.5, spacer: true },
              {
                id: 'grp',
                label: 'GRP',
                group: true,
                keys: [
                  {
                    id: 'g-b',
                    label: 'b',
                    action: { command: 'composition.insert', args: { text: 'b' } },
                  },
                  {
                    id: 'g-c',
                    label: 'c',
                    action: { command: 'composition.insert', args: { text: 'c' } },
                  },
                ],
              },
              {
                id: 'k-del',
                label: 'Delete',
                action: { command: 'composition.deleteGrapheme' },
                behaviour: {
                  type: 'escalate',
                  steps: [
                    { command: 'composition.deleteGrapheme' },
                    { command: 'composition.clear' },
                  ],
                  stepDwellClasses: ['function', 'destructive'],
                },
              },
              {
                id: 'k-num',
                label: '123',
                action: { command: 'layout.showPage', args: { page: 'other' } },
              },
            ],
          },
        ],
      },
      {
        id: 'other',
        name: 'Other',
        rows: [
          {
            height: 2,
            keys: [
              {
                id: 'k-1',
                label: '1',
                returnToPage: 'main',
                action: { command: 'composition.insert', args: { text: '1' } },
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Path to the first key of the main page, and to the group. */
const KEY = '/pages/0/rows/0/keys/0';
const GROUP = '/pages/0/rows/0/keys/2';
const DEL = '/pages/0/rows/0/keys/3';

function mutate(fn: (layout: Json) => void): unknown {
  const layout = base();
  fn(layout);
  return layout;
}

function issuePaths(input: unknown): string[] {
  const result = validateLayout(input);
  if (result.ok) return [];
  return result.issues.map((i) => i.path);
}

const keyOf = (l: Json) => l.pages[0].rows[0].keys[0] as Json;
const groupOf = (l: Json) => l.pages[0].rows[0].keys[2] as Json;
const delOf = (l: Json) => l.pages[0].rows[0].keys[3] as Json;

interface Case {
  readonly name: string;
  readonly input: unknown;
  /** Paths that must appear among the issues. */
  readonly paths: readonly string[];
  /** The JSON Schema can express this rule, so it must reject too. */
  readonly structural: boolean;
}

const CASES: Case[] = [
  { name: 'not an object', input: [], paths: [''], structural: true },
  { name: 'null', input: null, paths: [''], structural: true },
  {
    name: 'missing schemaVersion',
    input: mutate((l) => delete l.schemaVersion),
    paths: ['/schemaVersion'],
    structural: true,
  },
  {
    name: 'unsupported schemaVersion',
    input: mutate((l) => (l.schemaVersion = 2)),
    paths: ['/schemaVersion'],
    structural: true,
  },
  {
    name: 'unknown root field',
    input: mutate((l) => (l.colour = 'red')),
    paths: ['/colour'],
    structural: true,
  },
  { name: 'empty id', input: mutate((l) => (l.id = '')), paths: ['/id'], structural: true },
  {
    name: 'upper-case id',
    input: mutate((l) => (l.id = 'Test')),
    paths: ['/id'],
    structural: true,
  },
  {
    name: 'empty name',
    input: mutate((l) => (l.name = '')),
    paths: ['/name'],
    structural: true,
  },
  {
    name: 'bad family',
    input: mutate((l) => (l.family = 'medium')),
    paths: ['/family'],
    structural: true,
  },
  {
    name: 'bad locale',
    input: mutate((l) => (l.locale = 'english!')),
    paths: ['/locale'],
    structural: true,
  },
  {
    name: 'locale too short',
    input: mutate((l) => (l.locale = 'e')),
    paths: ['/locale'],
    structural: true,
  },
  {
    name: 'missing initialPage',
    input: mutate((l) => delete l.initialPage),
    paths: ['/initialPage'],
    structural: true,
  },
  {
    name: 'initialPage unknown',
    input: mutate((l) => (l.initialPage = 'nope')),
    paths: ['/initialPage'],
    structural: false,
  },
  {
    name: 'no pages',
    input: mutate((l) => (l.pages = [])),
    paths: ['/pages'],
    structural: true,
  },
  {
    name: 'duplicate page id',
    input: mutate((l) => (l.pages[1].id = 'main')),
    paths: ['/pages/1/id'],
    structural: false,
  },
  {
    name: 'page id with slash',
    input: mutate((l) => (l.pages[1].id = 'a/b')),
    paths: ['/pages/1/id'],
    structural: true,
  },
  {
    name: 'page without rows',
    input: mutate((l) => (l.pages[1].rows = [])),
    paths: ['/pages/1/rows'],
    structural: true,
  },
  {
    name: 'empty row',
    input: mutate((l) => (l.pages[1].rows[0].keys = [])),
    paths: ['/pages/1/rows/0/keys'],
    structural: true,
  },
  {
    name: 'row height zero',
    input: mutate((l) => (l.pages[1].rows[0].height = 0)),
    paths: ['/pages/1/rows/0/height'],
    structural: true,
  },
  {
    name: 'row height negative',
    input: mutate((l) => (l.pages[1].rows[0].height = -1)),
    paths: ['/pages/1/rows/0/height'],
    structural: true,
  },
  {
    name: 'row unknown field',
    input: mutate((l) => (l.pages[1].rows[0].gap = 2)),
    paths: ['/pages/1/rows/0/gap'],
    structural: true,
  },
  {
    name: 'duplicate key id',
    input: mutate((l) => (l.pages[1].rows[0].keys[0].id = 'k-a')),
    paths: ['/pages/1/rows/0/keys/0/id'],
    structural: false,
  },
  {
    name: 'key id duplicates group sub-key id',
    input: mutate((l) => (groupOf(l).keys[1].id = 'k-a')),
    paths: [`${GROUP}/keys/1/id`],
    structural: false,
  },
  {
    name: 'duplicate spacer id',
    input: mutate((l) => l.pages[1].rows[0].keys.push({ id: 'pad', spacer: true })),
    paths: ['/pages/1/rows/0/keys/1/id'],
    structural: false,
  },
  {
    name: 'key id empty',
    input: mutate((l) => (keyOf(l).id = '')),
    paths: [`${KEY}/id`],
    structural: true,
  },
  {
    name: 'key id with slash',
    input: mutate((l) => (keyOf(l).id = 'a/b')),
    paths: [`${KEY}/id`],
    structural: true,
  },
  {
    name: 'key width zero',
    input: mutate((l) => (keyOf(l).width = 0)),
    paths: [`${KEY}/width`],
    structural: true,
  },
  {
    name: 'key width infinite',
    input: mutate((l) => (keyOf(l).width = Infinity)),
    paths: [`${KEY}/width`],
    structural: true,
  },
  {
    name: 'key width string',
    input: mutate((l) => (keyOf(l).width = '2')),
    paths: [`${KEY}/width`],
    structural: true,
  },
  {
    name: 'label empty without icon',
    input: mutate((l) => (keyOf(l).label = '')),
    paths: [`${KEY}/label`],
    structural: true,
  },
  {
    name: 'label missing',
    input: mutate((l) => delete keyOf(l).label),
    paths: [`${KEY}/label`],
    structural: true,
  },
  {
    name: 'unknown key field',
    input: mutate((l) => (keyOf(l).dwellclass = 'letter')),
    paths: [`${KEY}/dwellclass`],
    structural: true,
  },
  {
    name: 'key with neither action nor group',
    input: mutate((l) => delete keyOf(l).action),
    paths: [`${KEY}/action`],
    structural: true,
  },
  {
    name: 'key with action and group',
    input: mutate((l) => (keyOf(l).group = true)),
    paths: [KEY],
    structural: true,
  },
  {
    name: 'spacer with action',
    input: mutate((l) => (l.pages[0].rows[0].keys[1].action = { command: 'x.y' })),
    paths: ['/pages/0/rows/0/keys/1'],
    structural: true,
  },
  {
    name: 'spacer false',
    input: mutate((l) => (l.pages[0].rows[0].keys[1].spacer = false)),
    paths: ['/pages/0/rows/0/keys/1/spacer'],
    structural: true,
  },
  {
    name: 'command empty',
    input: mutate((l) => (keyOf(l).action.command = '')),
    paths: [`${KEY}/action/command`],
    structural: true,
  },
  {
    name: 'command not a string',
    input: mutate((l) => (keyOf(l).action.command = 7)),
    paths: [`${KEY}/action/command`],
    structural: true,
  },
  {
    name: 'args an array',
    input: mutate((l) => (keyOf(l).action.args = [1])),
    paths: [`${KEY}/action/args`],
    structural: true,
  },
  {
    name: 'args a string',
    input: mutate((l) => (keyOf(l).action.args = 'a')),
    paths: [`${KEY}/action/args`],
    structural: true,
  },
  {
    name: 'args with NaN',
    input: mutate((l) => (keyOf(l).action.args = { n: NaN })),
    paths: [`${KEY}/action/args`],
    structural: false,
  },
  {
    name: 'args with a function',
    input: mutate((l) => (keyOf(l).action.args = { f: () => 1 })),
    paths: [`${KEY}/action/args`],
    structural: false,
  },
  {
    name: 'action unknown field',
    input: mutate((l) => (keyOf(l).action.extra = 1)),
    paths: [`${KEY}/action/extra`],
    structural: true,
  },
  {
    name: 'bad dwellClass',
    input: mutate((l) => (keyOf(l).dwellClass = 'fast')),
    paths: [`${KEY}/dwellClass`],
    structural: true,
  },
  {
    name: 'returnToPage unknown',
    input: mutate((l) => (keyOf(l).returnToPage = 'nope')),
    paths: [`${KEY}/returnToPage`],
    structural: false,
  },
  {
    name: 'returnToPage with showPage',
    input: mutate((l) => (l.pages[0].rows[0].keys[4].returnToPage = 'main')),
    paths: ['/pages/0/rows/0/keys/4/returnToPage'],
    structural: false,
  },
  {
    name: 'showPage without page',
    input: mutate((l) => (l.pages[0].rows[0].keys[4].action.args = {})),
    paths: ['/pages/0/rows/0/keys/4/action/args/page'],
    structural: false,
  },
  {
    name: 'showPage to unknown page',
    input: mutate((l) => (l.pages[0].rows[0].keys[4].action.args.page = 'zzz')),
    paths: ['/pages/0/rows/0/keys/4/action/args/page'],
    structural: false,
  },
  {
    name: 'behaviour type unknown',
    input: mutate((l) => (keyOf(l).behaviour = { type: 'hold' })),
    paths: [`${KEY}/behaviour/type`],
    structural: true,
  },
  {
    name: 'repeat interval zero',
    input: mutate((l) => (keyOf(l).behaviour = { type: 'repeat', intervalMs: 0 })),
    paths: [`${KEY}/behaviour/intervalMs`],
    structural: true,
  },
  {
    name: 'single with extra field',
    input: mutate((l) => (keyOf(l).behaviour = { type: 'single', intervalMs: 5 })),
    paths: [`${KEY}/behaviour/intervalMs`],
    structural: true,
  },
  {
    name: 'escalate without steps',
    input: mutate((l) => (delOf(l).behaviour.steps = [])),
    paths: [`${DEL}/behaviour/steps`],
    structural: true,
  },
  {
    name: 'escalate step without command',
    input: mutate((l) => (delOf(l).behaviour.steps[1] = {})),
    paths: [`${DEL}/behaviour/steps/1/command`],
    structural: true,
  },
  {
    name: 'escalate bad step class',
    input: mutate((l) => (delOf(l).behaviour.stepDwellClasses[1] = 'slow')),
    paths: [`${DEL}/behaviour/stepDwellClasses/1`],
    structural: true,
  },
  {
    name: 'escalate too many step classes',
    input: mutate((l) => delOf(l).behaviour.stepDwellClasses.push('function')),
    paths: [`${DEL}/behaviour/stepDwellClasses`],
    structural: false,
  },
  {
    name: 'group with one key',
    input: mutate((l) => (groupOf(l).keys = [groupOf(l).keys[0]])),
    paths: [`${GROUP}/keys`],
    structural: true,
  },
  {
    name: 'group without keys',
    input: mutate((l) => delete groupOf(l).keys),
    paths: [`${GROUP}/keys`],
    structural: true,
  },
  {
    name: 'group columns zero',
    input: mutate((l) => (groupOf(l).columns = 0)),
    paths: [`${GROUP}/columns`],
    structural: true,
  },
  {
    name: 'group columns fraction',
    input: mutate((l) => (groupOf(l).columns = 1.5)),
    paths: [`${GROUP}/columns`],
    structural: true,
  },
  {
    name: 'group label empty',
    input: mutate((l) => (groupOf(l).label = '')),
    paths: [`${GROUP}/label`],
    structural: true,
  },
  {
    name: 'group nested in group',
    input: mutate((l) => (groupOf(l).keys[0] = { id: 'inner', label: 'x', group: true, keys: [] })),
    paths: [`${GROUP}/keys/0`],
    structural: true,
  },
  {
    name: 'spacer in group',
    input: mutate((l) => (groupOf(l).keys[0] = { id: 'sp', spacer: true })),
    paths: [`${GROUP}/keys/0`],
    structural: true,
  },
  {
    name: 'group sub-key unknown field',
    input: mutate((l) => (groupOf(l).keys[0].foo = 1)),
    paths: [`${GROUP}/keys/0/foo`],
    structural: true,
  },
  {
    name: 'group sub-key layout.back',
    input: mutate((l) => (groupOf(l).keys[0].action = { command: 'layout.back' })),
    paths: [`${GROUP}/keys/0/action`],
    structural: false,
  },
  {
    name: 'coarse page with 13 targets',
    input: mutate((l) => {
      l.family = 'coarse';
      l.pages[1].rows[0].keys = Array.from({ length: 13 }, (_, i) => ({
        id: `x${i}`,
        label: 'x',
        action: { command: 'composition.insert', args: { text: 'x' } },
      }));
    }),
    paths: ['/pages/1'],
    structural: false,
  },
  {
    name: 'coarse group opening 13 targets',
    input: mutate((l) => {
      l.family = 'coarse';
      groupOf(l).keys = Array.from({ length: 12 }, (_, i) => ({
        id: `y${i}`,
        label: 'y',
        action: { command: 'composition.insert', args: { text: 'y' } },
      }));
    }),
    paths: [`${GROUP}/keys`],
    structural: false,
  },
  {
    name: 'description empty',
    input: mutate((l) => (l.description = '')),
    paths: ['/description'],
    structural: true,
  },
];

describe('validateLayout', () => {
  it('accepts the base layout, an unknown-free $schema reference and every built-in layout', () => {
    expect(validateLayout(base()).ok).toBe(true);
    const withSchema = { ...base(), $schema: './layout.schema.json' };
    const result = validateLayout(withSchema);
    expect(result.ok).toBe(true);
    if (result.ok) expect('$schema' in result.value).toBe(false);
    for (const layout of BUILTIN_LAYOUTS) expect(validateLayout(layout).ok).toBe(true);
  });

  it('accepts an empty label when the key has an icon', () => {
    const layout = mutate((l) => {
      keyOf(l).label = '';
      keyOf(l).icon = 'a';
    });
    expect(validateLayout(layout).ok).toBe(true);
  });

  it('accepts a coarse page with exactly 12 targets and a group that opens 12', () => {
    const layout = mutate((l) => {
      l.family = 'coarse';
      l.pages[1].rows[0].keys = Array.from({ length: 12 }, (_, i) => ({
        id: `x${i}`,
        label: 'x',
        action: { command: 'composition.insert', args: { text: 'x' } },
      }));
      groupOf(l).keys = Array.from({ length: 11 }, (_, i) => ({
        id: `y${i}`,
        label: 'y',
        action: { command: 'composition.insert', args: { text: 'y' } },
      }));
    });
    expect(issuePaths(layout)).toEqual([]);
  });

  it.each(CASES)('rejects: $name', ({ input, paths }) => {
    const result = validateLayout(input);
    expect(result.ok).toBe(false);
    const found = issuePaths(input);
    for (const path of paths) expect(found).toContain(path);
  });

  it('reports every issue, not only the first', () => {
    const input = mutate((l) => {
      l.family = 'x';
      l.locale = '!';
      keyOf(l).width = -1;
    });
    const found = issuePaths(input);
    expect(found).toEqual(expect.arrayContaining(['/family', '/locale', `${KEY}/width`]));
  });

  it('escapes slashes in unknown field names in paths', () => {
    expect(issuePaths(mutate((l) => (l['a/b'] = 1)))).toContain('/a~1b');
  });
});

describe('JSON Schema agrees with the validator', () => {
  const schema = LAYOUT_JSON_SCHEMA as Record<string, unknown>;

  it('is a draft 2020-12 schema', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('accepts the base layout and every built-in layout', () => {
    expect(matchesSchema(schema, schema, JSON.parse(JSON.stringify(base())))).toBe(true);
    for (const layout of BUILTIN_LAYOUTS) {
      expect(matchesSchema(schema, schema, JSON.parse(JSON.stringify(layout)))).toBe(true);
    }
  });

  it('accepts a root $schema reference', () => {
    expect(matchesSchema(schema, schema, { ...base(), $schema: './layout.schema.json' })).toBe(
      true,
    );
  });

  it.each(CASES.filter((c) => c.structural))('rejects structural case: $name', ({ input }) => {
    // JSON cannot carry Infinity, NaN or functions, so round-trip the way a file would.
    const asFile: unknown = JSON.parse(JSON.stringify(input));
    expect(matchesSchema(schema, schema, asFile)).toBe(false);
  });

  it('shares the id and locale patterns with the validator', async () => {
    const { LAYOUT_ID_PATTERN, LOCAL_ID_PATTERN, LOCALE_PATTERN } = await import('./validator');
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const defs = schema.$defs as Record<string, Record<string, unknown>>;
    expect(props.id?.pattern).toBe(LAYOUT_ID_PATTERN);
    expect(props.locale?.pattern).toBe(LOCALE_PATTERN);
    expect(defs.localId?.pattern).toBe(LOCAL_ID_PATTERN);
  });
});
