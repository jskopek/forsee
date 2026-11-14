/**
 * `forsee.quickfire`: one-dwell interjections, as a first-party plugin on the
 * public `ForseeApi`. It contributes a phrase set (`phraseSets` extension
 * point) and one command (`commands` extension point) that speaks a phrase
 * of the set at once, interrupting whatever is being said. It has no UI: the
 * app renders the phrase set and binds each tile to the command.
 *
 * Settings (namespace `forsee.quickfire`): one on/off switch per reply,
 * `show.<phrase id>`, all on by default. A reply switched off leaves the
 * phrase set (and so the screen); when every reply is off, no phrase set is
 * registered at all.
 *
 * Permissions: `speech.output` only. It never reads or changes the
 * composition (`speech.speak` does not touch it).
 */
import type {
  Disposable,
  ForseeApi,
  JsonValue,
  Phrase,
  PhraseSet,
  PluginManifest,
  PluginModule,
  SettingField,
} from '@forsee/plugin-api';
import manifestJson from '../manifest.json';

/** The plugin's manifest (validated by the plugin host when it loads). */
export const manifest = manifestJson as PluginManifest;

/** Plugin id. */
export const QUICKFIRE_PLUGIN_ID = 'forsee.quickfire';

/** Registered id of the phrase set (`<pluginId>/<local id>`). */
export const QUICKFIRE_PHRASE_SET_ID = 'forsee.quickfire/interjections';

/**
 * Command that speaks one quick-fire phrase with `interrupt: true`.
 * Arguments: `{ phraseId: string }` (an id of `QUICKFIRE_PHRASES`).
 */
export const QUICKFIRE_SPEAK_COMMAND = 'forsee.quickfire.speak';

/** The interjections, in display order. */
export const QUICKFIRE_PHRASES: readonly Phrase[] = [
  { id: 'yes', text: 'Yes' },
  { id: 'no', text: 'No' },
  { id: 'thank-you', text: 'Thank you' },
  { id: 'please-wait', text: 'Please wait' },
  { id: 'not-finished', text: "I'm not finished", label: 'Not finished' },
  { id: 'repeat', text: 'Can you repeat that?', label: 'Repeat that?' },
  { id: 'help', text: 'Help' },
];

/** The phrase set as registered (before the host prefixes its id). */
export const QUICKFIRE_PHRASE_SET: PhraseSet = {
  schemaVersion: 1,
  id: 'interjections',
  name: 'Quick-fire',
  locale: 'en',
  categories: [{ id: 'quickfire', name: 'Quick-fire', phrases: QUICKFIRE_PHRASES }],
};

/** Setting key that shows or hides one reply. */
export function showSettingKey(phraseId: string): string {
  return `show.${phraseId}`;
}

/** The plugin's settings: one switch per reply, in display order. */
export const QUICKFIRE_SETTING_FIELDS: readonly SettingField[] = QUICKFIRE_PHRASES.map(
  (phrase) => ({
    key: showSettingKey(phrase.id),
    label: phrase.label ?? phrase.text,
    description: `Show "${phrase.text}" in the quick replies.`,
    type: 'boolean',
    default: true,
  }),
);

/** The phrase set with only the replies switched on, or `null` when none is. */
export function visiblePhraseSet(settings: Readonly<Record<string, unknown>>): PhraseSet | null {
  const phrases = QUICKFIRE_PHRASES.filter(
    (phrase) => settings[showSettingKey(phrase.id)] !== false,
  );
  if (phrases.length === 0) return null;
  return {
    ...QUICKFIRE_PHRASE_SET,
    categories: [{ id: 'quickfire', name: 'Quick-fire', phrases }],
  };
}

function phraseIdOf(args: unknown): string {
  const id =
    typeof args === 'object' && args !== null && !Array.isArray(args)
      ? (args as Record<string, JsonValue | undefined>).phraseId
      : undefined;
  if (typeof id !== 'string') throw new TypeError(`${QUICKFIRE_SPEAK_COMMAND} needs { phraseId }`);
  return id;
}

/** The plugin module. */
export const quickfireModule: PluginModule = {
  async activate(api: ForseeApi) {
    await api.settings.registerSchema(QUICKFIRE_SETTING_FIELDS);

    // The phrase set follows the settings: re-registered (replaced) on change.
    let registered: Disposable | null = null;
    const apply = async (): Promise<void> => {
      const set = visiblePhraseSet(await api.settings.getAll());
      registered?.dispose();
      registered = set ? await api.register.phraseSet(set) : null;
    };
    await apply();
    let sync: Promise<void> = Promise.resolve();
    await api.events.on('settings.changed', () => {
      // One update at a time, in order. The phrase set is static and valid, so
      // an update fails only when the plugin was turned off meanwhile (the API
      // is disposed); then there is nothing left to show.
      sync = sync.then(apply).catch(() => undefined);
    });
    await api.register.command({
      id: QUICKFIRE_SPEAK_COMMAND,
      title: 'Speak a quick-fire reply',
      description: 'Speaks one of the quick-fire replies at once, interrupting current speech.',
      // The app and this plugin may run it; other plugins only with speech.output.
      public: true,
      requires: ['speech.output'],
      handler: async (args: unknown) => {
        const id = phraseIdOf(args);
        const phrase = QUICKFIRE_PHRASES.find((p) => p.id === id);
        if (!phrase) throw new RangeError(`No quick-fire phrase "${id}"`);
        await api.speech.speak(phrase.text, { interrupt: true });
        return { phraseId: phrase.id, text: phrase.text };
      },
    });
  },
};

/** The first-party plugin (manifest plus module). */
export const quickfirePlugin: { readonly manifest: PluginManifest; readonly module: PluginModule } =
  { manifest, module: quickfireModule };
