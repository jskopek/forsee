/**
 * `forsee.prediction-ngram`: the first-party word predictor as a plugin on
 * the public `ForseeApi` (ARCHITECTURE.md, "Trusted host infrastructure
 * versus features").
 *
 * It registers the n-gram provider from `@forsee/prediction` through
 * `api.register.predictionProvider`, so every request and every `learn`
 * call passes the plugin host's permission wrapper, exactly as a community
 * predictor's would. What it uses, and therefore declares:
 *
 * - `composition.read`: every prediction request carries the composition.
 * - `lm.write`: the host calls `learn` (the user spoke) and `forget` only with it.
 * - `history.read`: at activation, phrase recall is rebuilt from the user's
 *   recent utterances (`api.history.listRecent`). Without it the plugin
 *   still predicts words; it just starts with no phrases.
 *
 * Base model: the English model built from Tatoeba sentences, embedded in
 * the bundle (`@forsee/prediction/english`), unless `baseModel` says otherwise.
 *
 * Persistence: the user's learned words (the adaptive user model) are kept in
 * the plugin's private storage (`api.storage`, `plugins/<id>/data.json`),
 * because `ForseeApi` has no way to reach the profile's
 * `lm/user-counts.json`. Saves are coalesced: a `learn` resolves once a save
 * that includes it has finished, and bursts of learning share one write.
 * Phrases are not persisted separately; history is their source of truth.
 *
 * Settings (namespace `forsee.prediction-ngram`, `NGRAM_SETTING_FIELDS`):
 * - `learnWords`: learn the words the user speaks (default on). Off, `learn`
 *   does nothing, so nothing new is stored; what was learned stays in use.
 * - `nextWords`: suggest the next word before a word is started (default on).
 */
import type { Clock } from '@forsee/core';
import type {
  ForgetRequest,
  ForseeApi,
  JsonValue,
  LearnEvent,
  PluginManifest,
  PluginModule,
  PredictionProvider,
  SettingField,
} from '@forsee/plugin-api';
import {
  createNgramProvider,
  createPhraseRecall,
  createUserModel,
  type LanguageModel,
} from '@forsee/prediction';
import { loadEnglishModel } from '@forsee/prediction/english';
import manifestJson from '../manifest.json';

/** The plugin's manifest (validated by the plugin host when it loads). */
export const manifest = manifestJson as PluginManifest;

/** Plugin id. */
export const NGRAM_PLUGIN_ID = 'forsee.prediction-ngram';

/** Local provider id; the host registers it as `forsee.prediction-ngram/ngram`. */
export const NGRAM_LOCAL_PROVIDER_ID = 'ngram';

/** Private storage key of the serialised user model. */
export const USER_MODEL_KEY = 'userModel';

/** Recent utterances read back into phrase recall at activation. */
export const PHRASE_HISTORY_LIMIT = 500;

/** Setting: learn the words the user speaks. */
export const LEARN_WORDS_SETTING = 'learnWords';
/** Setting: suggest the next word before a word is started. */
export const NEXT_WORDS_SETTING = 'nextWords';

/** The plugin's settings. */
export const NGRAM_SETTING_FIELDS: readonly SettingField[] = [
  {
    key: LEARN_WORDS_SETTING,
    label: 'Learn my words',
    description:
      'Learn the words and phrases you speak so they are suggested sooner. Turning it off keeps what was already learned.',
    type: 'boolean',
    default: true,
  },
  {
    key: NEXT_WORDS_SETTING,
    label: 'Suggest the next word',
    description: 'Offer likely next words before you start typing a word.',
    type: 'boolean',
    default: true,
  },
];

/** Options of `createNgramPredictionPlugin`. */
export interface NgramPredictionPluginOptions {
  /**
   * Time for the recency weighting of learned words and phrases (wall
   * clock). `ForseeApi` has no clock, so the shell passes its own; a
   * sandboxed build would use the sandbox's.
   */
  readonly clock: Clock;
  /**
   * The base language model. Default: the English model built from Tatoeba
   * sentences (`@forsee/prediction/english`; CC BY 2.0 FR, credited in the
   * manifest description).
   */
  readonly baseModel?: () => LanguageModel;
  /** Locale of the user layer and phrase recall. Default `"en"`. */
  readonly locale?: string;
}

/** A first-party plugin: manifest plus module (the shape `FirstPartyPlugin` of `@forsee/plugin-host` expects). */
export interface NgramPredictionPlugin {
  readonly manifest: PluginManifest;
  readonly module: PluginModule;
}

/**
 * Coalesces saves: at most one write runs at a time, and a call made while
 * one is queued (not yet started) joins it. The value is read when the write
 * starts, so it always includes every change made before.
 */
function createSaver(write: () => Promise<void>): {
  save(): Promise<void>;
  idle(): Promise<void>;
} {
  let chain: Promise<void> = Promise.resolve();
  let queued: Promise<void> | null = null;
  return {
    save() {
      if (queued) return queued;
      const next = chain.then(() => {
        queued = null;
        return write();
      });
      queued = next;
      chain = next.catch(() => undefined);
      return next;
    },
    idle: () => chain,
  };
}

/** Builds the plugin. The returned module can be activated many times (enable, disable, enable). */
export function createNgramPredictionPlugin(
  options: NgramPredictionPluginOptions,
): NgramPredictionPlugin {
  const { clock } = options;
  const locale = options.locale ?? 'en';
  let base: LanguageModel | undefined;
  let active: { idle(): Promise<void> } | null = null;

  const module: PluginModule = {
    async activate(api: ForseeApi) {
      await api.settings.registerSchema(NGRAM_SETTING_FIELDS);
      const stored = await api.settings.getAll();
      const settings = {
        learnWords: stored[LEARN_WORDS_SETTING] !== false,
        nextWords: stored[NEXT_WORDS_SETTING] !== false,
      };
      await api.events.on('settings.changed', (change) => {
        if (change.key === LEARN_WORDS_SETTING) settings.learnWords = change.value !== false;
        if (change.key === NEXT_WORDS_SETTING) settings.nextWords = change.value !== false;
      });

      base ??= options.baseModel ? options.baseModel() : loadEnglishModel();
      const user = createUserModel({ clock, locale });
      const model = await api.storage.get(USER_MODEL_KEY);
      if (model !== undefined && !user.load(model)) {
        // Unreadable data is left in place (not overwritten until the user learns something new).
        throw new Error('The stored user language model could not be read');
      }

      const phrases = createPhraseRecall({ clock, locale });
      if (await api.permissions.has('history.read')) {
        for (const record of await api.history.listRecent(PHRASE_HISTORY_LIMIT)) {
          if (record.sender === 'user') phrases.add(record.body, record.createdAt);
        }
      }

      const ngram = createNgramProvider({ base, user, phrases });
      const saver = createSaver(() =>
        api.storage.set(USER_MODEL_KEY, user.serialise() as unknown as JsonValue),
      );
      active = saver;

      const provider: PredictionProvider = {
        id: NGRAM_LOCAL_PROVIDER_ID,
        capabilities: ngram.capabilities,
        predict: (request) => {
          const result = ngram.predict(request);
          return settings.nextWords ? result : { ...result, nextWords: [] };
        },
        async learn(event: LearnEvent) {
          if (!settings.learnWords) return;
          ngram.learn(event);
          await saver.save();
        },
        async forget(request: ForgetRequest) {
          ngram.forget(request);
          await saver.save();
        },
      };
      await api.register.predictionProvider(provider);
    },
    async deactivate() {
      const saver = active;
      active = null;
      await saver?.idle();
    },
  };

  return { manifest, module };
}
