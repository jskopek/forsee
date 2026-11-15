import type {
  BuiltinCommandId,
  CommandArgsMap,
  CompositionChange,
  ContextChange,
  Disposable,
  ExtensionChange,
  LocaleTag,
  PermissionScope,
  RegionState,
  SettingChange,
  SpeakCommandArgs,
  SpeakCommandResult,
  SpeakOptions,
  TextTransformTrigger,
  UtteranceRecord,
} from '@forsee/plugin-api';
import { ForseeError, defaultErrorReporter, type ErrorReporter } from './errors';
import { CommandRegistry, type CommandEventMap } from './commands';
import { CompositionBuffer, type CompositionSnapshot } from './composition';
import { ContextStore } from './context-store';
import { ConversationLog, type ConversationEventMap } from './conversation';
import { DisposableStore } from './disposable';
import { EventBus } from './event-bus';
import { ExtensionRegistry } from './extensions';
import { splitProfilePath, type Clock, type IdSource } from './platform';
import { RegionModel } from './regions';
import type {
  CompositionPersistence,
  ConversationPersistence,
  GazeControl,
  SettingsPersistence,
  SpeechService,
} from './services';
import { SettingsRegistry } from './settings';

/** Settings namespace the kernel registers for app-wide settings. */
export const GENERAL_SETTINGS_NAMESPACE = 'app.general';

/** Every event in the kernel, forwarded from its subsystems onto `Kernel.bus`. */
export interface KernelEventMap {
  'kernel.started': { readonly restoredComposition: boolean };
  'kernel.disposing': undefined;
  'composition.changed': CompositionChange;
  'conversation.appended': UtteranceRecord;
  'conversation.removed': ConversationEventMap['removed'];
  'settings.changed': SettingChange;
  'extensions.changed': ExtensionChange;
  'regions.changed': RegionState;
  'context.changed': ContextChange;
  'command.willExecute': CommandEventMap['willExecute'];
  'command.didExecute': CommandEventMap['didExecute'];
  'command.failed': CommandEventMap['failed'];
  /** `speech.speak` or `composition.speak` handed text to the speech service (or would have, if absent). */
  'speech.requested': { readonly text: string; readonly recordId: string | null };
  /**
   * Text could not be spoken: there is no speech service (`no-service`), the
   * service reports no usable voice (`no-voice`), or `speak` rejected or
   * resolved `error` (`error`). The text is not lost: it is in the event, in history (when
   * logged) and, for `composition.speak`, one undo away. The UI should show it.
   */
  'speech.unavailable': {
    readonly text: string;
    readonly recordId: string | null;
    readonly reason: 'no-service' | 'no-voice' | 'error';
  };
  'gaze.pauseChanged': { readonly paused: boolean };
}

/** Options for `createKernel`. */
export interface KernelOptions {
  readonly clock: Clock;
  readonly ids: IdSource;
  /** This installation's device id (`ProfileMetadata.deviceId`). */
  readonly deviceId: string;
  readonly persistence?: {
    readonly settings?: SettingsPersistence;
    readonly conversation?: ConversationPersistence;
    readonly composition?: CompositionPersistence;
  };
  readonly speech?: SpeechService;
  readonly gaze?: GazeControl;
  /** Where non-fatal errors go (listener errors, failed background saves). */
  readonly reportError?: ErrorReporter;
  /** Composition undo depth. Default 100. */
  readonly compositionHistoryLimit?: number;
  /**
   * Default for `app.general/autoCapitalise`. Default false, so text is kept
   * exactly as typed; the app turns it on.
   */
  readonly defaultAutoCapitalise?: boolean;
  /** Default locale for `app.general/locale`. Default `"en-GB"`. */
  readonly defaultLocale?: LocaleTag;
}

/** Result of `speech.speak` and `composition.speak` (defined in `@forsee/plugin-api`). */
export type { SpeakCommandResult };

/** The assembled kernel. */
export interface Kernel extends Disposable {
  readonly bus: EventBus<KernelEventMap>;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly commands: CommandRegistry;
  readonly composition: CompositionBuffer;
  readonly conversation: ConversationLog;
  readonly settings: SettingsRegistry;
  readonly extensions: ExtensionRegistry;
  readonly regions: RegionModel;
  readonly context: ContextStore;
  readonly speech: SpeechService | undefined;
  readonly gaze: GazeControl | undefined;
  readonly started: boolean;
  /** Current locale (`app.general/locale`). */
  readonly locale: LocaleTag;
  /**
   * Loads settings, conversation history and the crash-recovery snapshot.
   * Persistence failures are reported and do not stop start-up (the user
   * must be able to type even if the profile is unreadable). Call once.
   */
  start(): Promise<void>;
  /**
   * Runs the registered text transforms for `trigger` over `text`, in
   * registration order. A transform that throws or returns a non-string is
   * skipped and reported.
   */
  runTextTransforms(trigger: TextTransformTrigger, text: string): Promise<string>;
  /** Resolves when all pending background writes have finished. */
  flush(): Promise<void>;
}

const WORD_BOUNDARY = /[\s.,!?;:]$/u;

const SPEAK_OPTION_KEYS: ReadonlySet<string> = new Set([
  'text',
  'log',
  'voiceId',
  'rate',
  'pitch',
  'volume',
  'recording',
  'interrupt',
]);

function invalidSpeak(message: string): never {
  throw new ForseeError('invalid-argument', `speech.speak: ${message}`);
}

function speakNumber(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalidSpeak(`${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

function speakBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') invalidSpeak(`${name} must be a boolean`);
  return value;
}

/** Whether `path` is a safe profile-relative path (no `..`, no scheme, no backslash). */
function isSafeProfilePath(path: string): boolean {
  if (path === '' || path.length > 512 || path.includes(':')) return false;
  try {
    splitProfilePath(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates the arguments of `speech.speak` (they may come from a layout
 * file or a plugin) and splits them into text, log flag and speech options.
 */
function readSpeakArgs(args: unknown): { text: string; log: boolean; options: SpeakOptions } {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    invalidSpeak('needs { text: string }; to speak the composition use composition.speak');
  }
  const a = args as Partial<Record<keyof SpeakCommandArgs, unknown>>;
  for (const key of Object.keys(a)) {
    if (!SPEAK_OPTION_KEYS.has(key)) invalidSpeak(`unknown argument ${JSON.stringify(key)}`);
  }
  if (typeof a.text !== 'string' || a.text.trim() === '') {
    invalidSpeak('text must be a non-empty string; to speak the composition use composition.speak');
  }
  if (a.voiceId !== undefined && (typeof a.voiceId !== 'string' || a.voiceId === '')) {
    invalidSpeak('voiceId must be a non-empty string');
  }
  if (a.recording !== undefined) {
    if (typeof a.recording !== 'string' || !isSafeProfilePath(a.recording)) {
      invalidSpeak('recording must be a safe profile-relative path');
    }
  }
  const rate = speakNumber(a.rate, 'rate', 0.1, 10);
  const pitch = speakNumber(a.pitch, 'pitch', 0, 2);
  const volume = speakNumber(a.volume, 'volume', 0, 1);
  const interrupt = speakBoolean(a.interrupt, 'interrupt');
  const log = speakBoolean(a.log, 'log');
  return {
    text: a.text,
    log: log !== false,
    options: {
      ...(a.voiceId === undefined ? {} : { voiceId: a.voiceId }),
      ...(rate === undefined ? {} : { rate }),
      ...(pitch === undefined ? {} : { pitch }),
      ...(volume === undefined ? {} : { volume }),
      ...(a.recording === undefined ? {} : { recording: a.recording }),
      ...(interrupt === undefined ? {} : { interrupt }),
    },
  };
}

/** Composition root: wires the kernel subsystems and registers the built-in commands. */
export function createKernel(options: KernelOptions): Kernel {
  const reportError = options.reportError ?? defaultErrorReporter;
  const { clock, ids } = options;
  const disposables = new DisposableStore();
  const listenerOptions = { onListenerError: reportError };

  const bus = new EventBus<KernelEventMap>(listenerOptions);
  const commands = new CommandRegistry({ ...listenerOptions, clock });
  const composition = new CompositionBuffer({
    ...listenerOptions,
    clock,
    ...(options.compositionHistoryLimit === undefined
      ? {}
      : { historyLimit: options.compositionHistoryLimit }),
  });
  const conversation = new ConversationLog({
    clock,
    ids,
    deviceId: options.deviceId,
    reportError,
    ...(options.persistence?.conversation ? { persistence: options.persistence.conversation } : {}),
  });
  const settings = new SettingsRegistry({
    reportError,
    ...(options.persistence?.settings ? { persistence: options.persistence.settings } : {}),
  });
  const extensions = new ExtensionRegistry(listenerOptions);
  const regions = new RegionModel(listenerOptions);
  const context = new ContextStore({ ...listenerOptions, clock });
  const { speech, gaze } = options;

  // Forward subsystem events onto the kernel bus.
  disposables.add(composition.events.on('changed', (e) => bus.emit('composition.changed', e)));
  disposables.add(conversation.events.on('appended', (e) => bus.emit('conversation.appended', e)));
  disposables.add(conversation.events.on('removed', (e) => bus.emit('conversation.removed', e)));
  disposables.add(settings.events.on('changed', (e) => bus.emit('settings.changed', e)));
  disposables.add(extensions.events.on('changed', (e) => bus.emit('extensions.changed', e)));
  disposables.add(regions.events.on('changed', (e) => bus.emit('regions.changed', e)));
  disposables.add(context.events.on('changed', (e) => bus.emit('context.changed', e)));
  disposables.add(commands.events.on('willExecute', (e) => bus.emit('command.willExecute', e)));
  disposables.add(commands.events.on('didExecute', (e) => bus.emit('command.didExecute', e)));
  disposables.add(commands.events.on('failed', (e) => bus.emit('command.failed', e)));

  disposables.add(
    settings.registerSchema(GENERAL_SETTINGS_NAMESPACE, [
      {
        key: 'locale',
        label: 'Language',
        type: 'string',
        description: 'Language used for prediction, layouts and voices (BCP 47 tag).',
        default: options.defaultLocale ?? 'en-GB',
      },
      {
        key: 'autoCapitalise',
        label: 'Automatic capitals',
        type: 'boolean',
        description:
          'A capital letter at the start of each sentence, and "I" on its own in English.',
        default: options.defaultAutoCapitalise ?? false,
      },
    ]),
  );
  const getLocale = (): LocaleTag => String(settings.get(GENERAL_SETTINGS_NAMESPACE, 'locale'));

  // Automatic capitals follow the setting and, for the pronoun "I", the language.
  const applyAutoCapitalise = (): void => {
    const on = settings.get(GENERAL_SETTINGS_NAMESPACE, 'autoCapitalise') !== false;
    const english = getLocale().toLowerCase().startsWith('en');
    composition.autoCapitalise = !on ? 'off' : english ? 'sentences-and-i' : 'sentences';
  };
  applyAutoCapitalise();
  disposables.add(
    settings.events.on('changed', (change) => {
      if (change.namespace === GENERAL_SETTINGS_NAMESPACE) applyAutoCapitalise();
    }),
  );

  // Crash recovery: save the composition on every change, coalescing bursts.
  const compositionPersistence = options.persistence?.composition;
  let pendingSnapshot: CompositionSnapshot | null = null;
  let compositionChain: Promise<void> = Promise.resolve();
  const saveComposition = (): void => {
    if (!compositionPersistence) return;
    const alreadyQueued = pendingSnapshot !== null;
    pendingSnapshot = composition.snapshot();
    if (alreadyQueued) return;
    compositionChain = compositionChain
      .then(() => {
        const snapshot = pendingSnapshot;
        pendingSnapshot = null;
        return snapshot ? compositionPersistence.save(snapshot) : undefined;
      })
      .catch((error: unknown) => reportError(error, 'composition.persist'));
  };
  disposables.add(composition.events.on('changed', saveComposition));

  const runTextTransforms = async (
    trigger: TextTransformTrigger,
    text: string,
  ): Promise<string> => {
    let current = text;
    for (const { id, contribution } of extensions.list('textTransforms')) {
      if (!contribution.triggers.includes(trigger)) continue;
      try {
        const result = await contribution.transform({
          trigger,
          text: current,
          locale: getLocale(),
        });
        if (typeof result === 'string') current = result;
        else if (result !== null) throw new TypeError('transform returned a non-string');
      } catch (error) {
        reportError(error, `textTransform:${id}`);
      }
    }
    return current;
  };

  const applyWordBoundaryTransforms = (): void => {
    if (extensions.list('textTransforms').length === 0) return;
    const before = composition.text;
    runTextTransforms('word-boundary', before).then(
      (after) => {
        // Only apply if the user has not typed in the meantime.
        if (after !== before && composition.text === before) composition.replace(after);
      },
      (error: unknown) => reportError(error, 'textTransform'),
    );
  };

  // ---- built-in commands
  const register = <K extends BuiltinCommandId>(
    id: K,
    title: string,
    handler: (args: CommandArgsMap[K]) => unknown,
    requires: readonly PermissionScope[] = [],
    isPublic = true,
  ): void => {
    disposables.add(
      commands.register(id, (args) => handler(args as CommandArgsMap[K]), {
        title,
        public: isPublic,
        requires,
      }),
    );
  };
  const writesComposition: readonly PermissionScope[] = ['composition.write'];

  register(
    'composition.insert',
    'Type text',
    (args) => {
      if (typeof args?.text !== 'string') {
        throw new ForseeError('invalid-argument', 'composition.insert needs { text: string }');
      }
      composition.insert(args.text, args.distribution);
      if (WORD_BOUNDARY.test(args.text)) applyWordBoundaryTransforms();
    },
    writesComposition,
  );
  register(
    'composition.deleteGrapheme',
    'Delete letter',
    () => composition.deleteGrapheme(),
    writesComposition,
  );
  register(
    'composition.deleteWord',
    'Delete word',
    () => composition.deleteWord(),
    writesComposition,
  );
  register('composition.clear', 'Clear', () => composition.clear(), writesComposition);
  register('composition.undo', 'Undo', () => composition.undo(), writesComposition);
  register(
    'composition.acceptPrediction',
    'Accept prediction',
    (args) => {
      if (typeof args?.text !== 'string') {
        throw new ForseeError(
          'invalid-argument',
          'composition.acceptPrediction needs { text: string }',
        );
      }
      composition.acceptPrediction(args.text);
    },
    writesComposition,
  );
  /**
   * The shared tail of `speech.speak` and `composition.speak`: commit
   * transforms, history, then the speech service. Never touches the
   * composition.
   */
  const speakText = async (
    raw: string,
    log: boolean,
    options: SpeakOptions,
  ): Promise<SpeakCommandResult> => {
    if (raw === '') return { spoken: false, text: '', recordId: null };
    const text = (await runTextTransforms('commit', raw)).trim();
    if (text === '') return { spoken: false, text: '', recordId: null };
    const record = log ? conversation.append({ body: text, sender: 'user' }) : null;
    const recordId = record?.id ?? null;
    bus.emit('speech.requested', { text, recordId });
    if (!speech || speech.isAvailable?.() === false) {
      bus.emit('speech.unavailable', {
        text,
        recordId,
        reason: speech ? 'no-voice' : 'no-service',
      });
      return { spoken: false, text, recordId };
    }
    // A speech engine reports failure by resolving `error` (its queue never
    // rejects), a broken service by rejecting: either way the text was not
    // spoken, and the UI must be told.
    speech.speak(text, options).then(
      (reason) => {
        if (reason === 'error') bus.emit('speech.unavailable', { text, recordId, reason: 'error' });
      },
      (error: unknown) => {
        reportError(error, 'speech.speak');
        bus.emit('speech.unavailable', { text, recordId, reason: 'error' });
      },
    );
    return { spoken: true, text, recordId };
  };

  register(
    'speech.speak',
    'Speak text',
    (args) => {
      const { text, log, options } = readSpeakArgs(args);
      return speakText(text.trim(), log, options);
    },
    ['speech.output'],
  );
  register(
    'composition.speak',
    'Speak',
    (args) => {
      if (args !== undefined && (typeof args !== 'object' || args === null)) {
        throw new ForseeError('invalid-argument', 'composition.speak takes { log?: boolean }');
      }
      if (args?.log !== undefined && typeof args.log !== 'boolean') {
        throw new ForseeError('invalid-argument', 'composition.speak: log must be a boolean');
      }
      // Commit synchronously, inside `execute`, so nothing typed after the
      // Speak key is swept into this utterance.
      return speakText(composition.commit(), args?.log !== false, {});
    },
    ['speech.output', 'composition.read', 'composition.write'],
  );
  register(
    'speech.stop',
    'Stop speaking',
    () => {
      if (!speech) return false;
      speech.stop();
      return true;
    },
    ['speech.output'],
  );
  // Pausing or resuming selection changes whether the user can type at all,
  // so plugins cannot do it; the app, layout keys and the wake target can.
  register(
    'gaze.pause',
    'Pause gaze',
    () => {
      if (!gaze) return false;
      gaze.pause();
      bus.emit('gaze.pauseChanged', { paused: true });
      return true;
    },
    [],
    false,
  );
  register(
    'gaze.resume',
    'Resume gaze',
    () => {
      if (!gaze) return false;
      gaze.resume();
      bus.emit('gaze.pauseChanged', { paused: false });
      return true;
    },
    [],
    false,
  );

  let started = false;
  let disposed = false;

  const kernel: Kernel = {
    bus,
    clock,
    ids,
    commands,
    composition,
    conversation,
    settings,
    extensions,
    regions,
    context,
    speech,
    gaze,
    get started() {
      return started;
    },
    get locale() {
      return getLocale();
    },
    async start() {
      if (disposed) throw new ForseeError('disposed', 'Kernel is disposed');
      if (started) throw new ForseeError('invalid-argument', 'Kernel already started');
      started = true;
      try {
        await settings.loadFromPersistence();
      } catch (error) {
        reportError(error, 'kernel.start.settings');
      }
      try {
        await conversation.load();
      } catch (error) {
        reportError(error, 'kernel.start.conversation');
      }
      let restoredComposition = false;
      if (compositionPersistence) {
        try {
          const snapshot = await compositionPersistence.load();
          if (snapshot !== undefined) {
            restoredComposition = composition.restore(snapshot) && composition.text !== '';
          }
        } catch (error) {
          reportError(error, 'kernel.start.composition');
        }
      }
      bus.emit('kernel.started', { restoredComposition });
    },
    runTextTransforms,
    async flush() {
      await Promise.all([conversation.flush(), settings.flush(), compositionChain]);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      bus.emit('kernel.disposing', undefined);
      try {
        disposables.dispose();
      } catch (error) {
        reportError(error, 'kernel.dispose');
      }
      for (const part of [
        commands,
        composition,
        conversation,
        settings,
        extensions,
        regions,
        context,
      ]) {
        part.dispose();
      }
      bus.dispose();
    },
  };
  return kernel;
}
