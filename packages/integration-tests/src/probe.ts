/**
 * A probe plugin for capability tests. It uses every `ForseeApi` method,
 * subscribes to every event, registers every kind of provider and handler,
 * and executes every command it can list, recording everything that reaches
 * its code: method results, rejections, event payloads and every argument
 * the app passes into its providers and handlers. Test-only code.
 */
import { BUILTIN_LAYOUTS } from '@forsee/layouts';
import {
  FIXED_PERMISSION_SCOPES,
  PLUGIN_EVENT_PERMISSIONS,
  type ForseeApi,
  type ForseeEventType,
  type JsonObject,
  type PermissionScope,
  type PredictionResult,
} from '@forsee/plugin-api';
import type { FirstPartyPlugin, PluginApiMethod } from '@forsee/plugin-host';
import { firstParty } from './harness';

/** Every permission a plugin can hold (one network scope stands for all). */
export const ALL_SCOPES: readonly PermissionScope[] = [
  ...FIXED_PERMISSION_SCOPES,
  'network:api.example.com',
];

export interface Probe {
  readonly plugin: FirstPartyPlugin;
  /** Everything that reached the probe's code, serialised. */
  readonly observed: string[];
  /** The API methods the probe calls (for a completeness check). */
  readonly methods: readonly string[];
  /** Calls every API method once more (`round` keeps registration ids unique). */
  exercise(round: number): Promise<void>;
  /** Text of everything observed, for `toContain` checks. */
  text(): string;
}

/** Arguments for built-in commands that need some. Values are the probe's own. */
const COMMAND_ARGS: Readonly<Record<string, JsonObject>> = {
  'composition.insert': { text: 'p' },
  'composition.acceptPrediction': { text: 'p' },
  'speech.speak': { text: 'probe says', log: false },
  'layout.showPage': { page: 'letters' },
};

function serialise(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_key, v: unknown) => {
        if (typeof v === 'function') return '[function]';
        if (v instanceof Error) {
          return { name: v.name, message: v.message, ...(v as unknown as Record<string, unknown>) };
        }
        return v;
      }) ?? 'undefined'
    );
  } catch {
    return String(value);
  }
}

export function createProbe(id: string, permissions: readonly PermissionScope[]): Probe {
  const observed: string[] = [];
  let api: ForseeApi | undefined;
  const see = (where: string, value: unknown): void => {
    observed.push(`${where}: ${serialise(value)}`);
  };
  const attempt = async (where: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      see(`${where} ->`, await run());
    } catch (error) {
      see(`${where} !>`, error);
    }
  };

  const prediction = (requestId: number): PredictionResult => ({
    requestId,
    providerId: 'probe',
    stage: 'instant',
    completions: [{ text: 'probe', score: 0.5 }],
    nextWords: [],
    letters: {},
    phrases: [],
  });

  /** One call per API method; the type makes the table complete. */
  const methods: Record<PluginApiMethod, (a: ForseeApi, round: number) => Promise<unknown>> = {
    // Reads first, so they see the state the app left before the probe changes it.
    'composition.getState': (a) => a.composition.getState(),
    'history.listRecent': (a) => a.history.listRecent(100),
    'context.get': (a) => a.context.get('time.partOfDay'),
    'context.list': (a) => a.context.list(),
    'commands.list': (a) => a.commands.list(),
    'speech.listVoices': (a) => a.speech.listVoices(),
    'events.on': async (a) => {
      for (const type of Object.keys(PLUGIN_EVENT_PERMISSIONS) as ForseeEventType[]) {
        await attempt(`events.on ${type}`, () =>
          a.events.on(type, (payload) => see(`event ${type}`, payload)),
        );
      }
    },
    'commands.execute': async (a) => {
      const list = await a.commands.list();
      for (const { id: commandId } of list) {
        await attempt(`execute ${commandId}`, () =>
          a.commands.execute(commandId, COMMAND_ARGS[commandId]),
        );
      }
    },
    'commands.register': (a, round) =>
      a.commands.register(
        `${id}.cmd${round}`,
        (args, context) => {
          see('own command', { args, context });
          return null;
        },
        { title: 'Probe', public: true },
      ),
    'composition.insert': (a) => a.composition.insert('p'),
    'composition.deleteGrapheme': (a) => a.composition.deleteGrapheme(),
    'composition.deleteWord': (a) => a.composition.deleteWord(),
    'composition.clear': (a) => a.composition.clear(),
    'composition.acceptPrediction': (a) => a.composition.acceptPrediction('p'),
    'composition.replace': (a) => a.composition.replace('p'),
    'composition.undo': async (a) => {
      // Far enough back to reach anything said before.
      for (let i = 0; i < 30; i += 1) {
        await attempt('composition.undo', () => a.composition.undo());
        await attempt('commands composition.undo', () => a.commands.execute('composition.undo'));
      }
    },
    'speech.speak': (a) => a.speech.speak('probe says', { log: false }),
    'speech.stop': (a) => a.speech.stop(),
    'settings.registerSchema': (a) =>
      a.settings.registerSchema([{ key: 'k', label: 'K', type: 'string', default: '' }]),
    'settings.get': (a) => a.settings.get('k'),
    'settings.set': (a) => a.settings.set('k', 'v'),
    'settings.getAll': (a) => a.settings.getAll(),
    'storage.get': (a) => a.storage.get('k'),
    'storage.set': (a) => a.storage.set('k', 1),
    'storage.delete': (a) => a.storage.delete('k'),
    'storage.keys': (a) => a.storage.keys(),
    'context.set': (a) => a.context.set({ key: 'probe.k', value: 1 }),
    'context.delete': (a) => a.context.delete('probe.k'),
    'permissions.has': async (a) => {
      for (const scope of ALL_SCOPES) await attempt(`has ${scope}`, () => a.permissions.has(scope));
    },
    'permissions.request': async (a) => {
      for (const scope of ALL_SCOPES) {
        await attempt(`request ${scope}`, () => a.permissions.request(scope));
      }
    },
    'panels.setTargets': (a) =>
      a.panels.setTargets('p', [
        { id: 't', rect: { x: 0, y: 0, width: 10, height: 10 }, dwellClass: 'function' },
      ]),
    'panels.onActivate': (a) => a.panels.onActivate((activation) => see('panel', activation)),
    'inference.getStatus': (a) => a.inference?.getStatus() ?? Promise.resolve('no inference'),
    'inference.listModels': (a) => a.inference?.listModels() ?? Promise.resolve('no inference'),
    'inference.loadModel': (a) => a.inference?.loadModel('m') ?? Promise.resolve('no inference'),
    'inference.unloadModel': (a) =>
      a.inference?.unloadModel('h') ?? Promise.resolve('no inference'),
    'inference.scoreNextTokens': (a) =>
      a.inference?.scoreNextTokens({ handleId: 'h', prompt: 'p', topK: 1 }) ??
      Promise.resolve('no inference'),
    'inference.generate': (a) =>
      a.inference?.generate({ handleId: 'h', prompt: 'p', maxTokens: 1 }) ??
      Promise.resolve('no inference'),
    'register.layout': (a, round) => {
      const base = BUILTIN_LAYOUTS[0];
      if (!base) throw new Error('no built-in layout');
      return a.register.layout({ ...base, id: `layout${round}` });
    },
    'register.theme': (a, round) =>
      a.register.theme({ id: `theme${round}`, name: 'T', colorScheme: 'dark', tokens: {} }),
    'register.phraseSet': (a, round) =>
      a.register.phraseSet({
        schemaVersion: 1,
        id: `phrases${round}`,
        name: 'P',
        locale: 'en-GB',
        categories: [],
      }),
    'register.vocabulary': (a, round) =>
      a.register.vocabulary({
        schemaVersion: 1,
        id: `vocabulary${round}`,
        name: 'V',
        locale: 'en',
        entries: [{ text: 'probe', weight: 1 }],
      }),
    'register.command': (a, round) =>
      a.register.command({
        id: `contributed${round}`,
        title: 'Probe',
        public: true,
        handler: (args, context) => {
          see('contributed command', { args, context });
          return null;
        },
      }),
    'register.predictionProvider': (a, round) =>
      a.register.predictionProvider({
        id: `predict${round}`,
        capabilities: {
          kinds: ['completions', 'nextWords', 'letters', 'phrases'],
          usesKeyDistributions: true,
        },
        predict: (request) => {
          see('predict', request);
          return prediction(request.requestId);
        },
        refine: (request) => {
          see('refine', request);
          return Promise.resolve(null);
        },
        learn: (event) => {
          see('learn', event);
        },
        forget: (request) => {
          see('forget', request);
        },
      }),
    'register.contextProvider': (a, round) =>
      a.register.contextProvider({
        id: `context${round}`,
        name: 'Probe',
        provides: ['probe.k'],
        refresh: () => {
          see('context refresh', null);
          return [];
        },
      }),
    'register.textTransform': (a, round) =>
      a.register.textTransform({
        id: `transform${round}`,
        name: 'Probe',
        triggers: ['word-boundary', 'commit'],
        transform: (input) => {
          see('transform', input);
          return `PROBE ${input.text}`;
        },
      }),
    'register.voiceProvider': (a, round) =>
      a.register.voiceProvider({
        id: `voice${round}`,
        listVoices: () =>
          Promise.resolve([
            { id: 'v', providerId: 'x', name: 'Probe voice', locale: 'en-GB', local: true },
          ]),
        speak: (utterance, events) => {
          see('voice speak', utterance);
          events.onStart?.({ type: 'start', utteranceId: utterance.id, t: 0 });
          events.onEnd?.({ type: 'end', utteranceId: utterance.id, reason: 'completed', t: 0 });
          return {
            utteranceId: utterance.id,
            stop: () => undefined,
            done: Promise.resolve('completed'),
          };
        },
        stop: () => undefined,
      }),
    'register.outputSink': (a, round) =>
      a.register.outputSink({
        id: `sink${round}`,
        name: 'Probe',
        send: (payload) => {
          see('sink', payload);
          return Promise.resolve();
        },
      }),
    'register.gazeSource': (a, round) =>
      a.register.gazeSource({
        id: `gaze${round}`,
        name: 'Probe',
        kind: 'driver',
        executable: { linux: 'bin/driver' },
      }),
  };

  const exercise = async (round: number): Promise<void> => {
    if (!api) throw new Error('probe not activated');
    const forsee = api;
    for (const [method, run] of Object.entries(methods)) {
      await attempt(`${method} #${round}`, () => run(forsee, round));
    }
  };

  const plugin = firstParty(
    id,
    permissions,
    {
      async activate(forsee) {
        api = forsee;
        await exercise(0);
      },
    },
    { panels: [{ id: 'p', entry: 'p.html', region: 'side' }] },
  );

  return {
    plugin,
    observed,
    methods: Object.keys(methods),
    exercise,
    text: () => observed.join('\n'),
  };
}
