import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  API_VERSION,
  BUILTIN_COMMAND_IDS,
  DWELL_CLASSES,
  EXTENSION_POINTS,
  FIXED_PERMISSION_SCOPES,
  PLUGIN_API_PACKAGE,
  PLUGIN_EVENT_PERMISSIONS,
  REGION_IDS,
  SENSITIVE_PERMISSION_SCOPES,
  type CommandArgs,
  type CommandArgsMap,
  type ContributionMap,
  type ForseeEventMap,
  type LayoutDefinition,
  type PermissionScope,
  type PluginManifest,
  type PredictionResult,
  type RpcMessage,
} from './index';

// Available in Node and browsers, but not part of the ES2022 lib this package compiles against.
declare function structuredClone<T>(value: T): T;

describe('constants', () => {
  it('exports its package name and API version', () => {
    expect(PLUGIN_API_PACKAGE).toBe('@forsee/plugin-api');
    expect(API_VERSION).toBe(1);
  });

  it('lists every built-in command exactly once', () => {
    const fromMap: Record<keyof CommandArgsMap, true> = {
      'composition.insert': true,
      'composition.deleteGrapheme': true,
      'composition.deleteWord': true,
      'composition.clear': true,
      'composition.undo': true,
      'composition.acceptPrediction': true,
      'speech.speak': true,
      'speech.stop': true,
      'gaze.pause': true,
      'gaze.resume': true,
    };
    expect([...BUILTIN_COMMAND_IDS].sort()).toEqual(Object.keys(fromMap).sort());
  });

  it('has consistent permission, region, dwell and extension lists', () => {
    expect(new Set(FIXED_PERMISSION_SCOPES).size).toBe(FIXED_PERMISSION_SCOPES.length);
    for (const scope of SENSITIVE_PERMISSION_SCOPES)
      expect(FIXED_PERMISSION_SCOPES).toContain(scope);
    for (const scope of Object.values(PLUGIN_EVENT_PERMISSIONS)) {
      if (scope !== null) expect(FIXED_PERMISSION_SCOPES).toContain(scope);
    }
    expect(REGION_IDS).toHaveLength(5);
    expect(DWELL_CLASSES).toEqual(['letter', 'prediction', 'function', 'destructive']);
    expect(Object.keys(EXTENSION_POINTS)).toHaveLength(13);
  });
});

describe('types', () => {
  it('accepts the manifest example from the plan', () => {
    const manifest = {
      id: 'community.example-phrases',
      name: 'Example phrases',
      version: '1.2.0',
      apiVersion: 1,
      minAppVersion: '1.0.0',
      description: '…',
      author: '…',
      authorUrl: '…',
      fundingUrl: '…',
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
      permissions: ['composition.read', 'speech.output', 'network:api.example.com'],
      optionalPermissions: ['history.read'],
    } satisfies PluginManifest;
    expect(manifest.id).toBe('community.example-phrases');
    expectTypeOf<'network:example.org'>().toExtend<PermissionScope>();
    expectTypeOf<'netwrk:x'>().not.toExtend<PermissionScope>();
  });

  it('types built-in command args and leaves others as JSON', () => {
    expectTypeOf<CommandArgs<'composition.acceptPrediction'>>().toEqualTypeOf<{
      readonly text: string;
    }>();
    expectTypeOf<CommandArgs<'composition.clear'>>().toEqualTypeOf<undefined>();
    expectTypeOf<{ page: string }>().toExtend<CommandArgs<'plugin.custom'>>();
  });

  it('describes a coarse layout with a two-step group key', () => {
    const layout: LayoutDefinition = {
      schemaVersion: 1,
      id: 'forsee/coarse-abc',
      name: 'Large ABC',
      family: 'coarse',
      locale: 'en-GB',
      initialPage: 'letters',
      pages: [
        {
          id: 'letters',
          name: 'Letters',
          rows: [
            {
              keys: [
                {
                  id: 'g-abcd',
                  label: 'ABCD',
                  group: true,
                  keys: ['a', 'b', 'c', 'd'].map((c) => ({
                    id: `k-${c}`,
                    label: c,
                    action: { command: 'composition.insert', args: { text: c } },
                  })),
                },
                { id: 'gap', spacer: true },
                {
                  id: 'del',
                  label: 'Delete',
                  dwellClass: 'destructive',
                  action: { command: 'composition.deleteGrapheme' },
                  behaviour: {
                    type: 'escalate',
                    steps: [
                      { command: 'composition.deleteGrapheme' },
                      { command: 'composition.deleteWord' },
                      { command: 'composition.clear' },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(layout.pages[0]?.rows[0]?.keys).toHaveLength(3);
  });

  it('keeps contribution and event maps keyed consistently', () => {
    expectTypeOf<keyof ContributionMap>().toEqualTypeOf<keyof typeof EXTENSION_POINTS>();
    expectTypeOf<keyof ForseeEventMap>().toEqualTypeOf<keyof typeof PLUGIN_EVENT_PERMISSIONS>();
  });

  it('keeps shared data structured-clone safe', () => {
    const result: PredictionResult = {
      requestId: 3,
      providerId: 'forsee.ngram',
      stage: 'instant',
      completions: [{ text: 'hello', score: 0.5 }],
      nextWords: [],
      letters: { l: 0.7 },
      phrases: [],
    };
    const message: RpcMessage = {
      protocol: 'forsee-rpc',
      version: 1,
      kind: 'result',
      id: 1,
      result,
    };
    expect(structuredClone(message)).toEqual(message);
  });
});
