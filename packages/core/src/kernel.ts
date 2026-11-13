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
import type { Clock, IdSource } from './platform';
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
  /** `speech.speak` handed text to the speech service (or would have, if absent). */
  'speech.requested': { readonly text: string; readonly recordId: string | null };
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
  /** Default locale for `app.general/locale`. Default `"en-GB"`. */
  readonly defaultLocale?: LocaleTag;
}

/** Result of the `speech.speak` command. */
export interface SpeakCommandResult {
  /** True if a speech service was asked to speak. */
  readonly spoken: boolean;
  /** The text after commit transforms ("" if there was nothing to say). */
  readonly text: string;
  /** History record id, or null when not logged. */
  readonly recordId: string | null;
}

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
    ]),
  );
  const getLocale = (): LocaleTag => String(settings.get(GENERAL_SETTINGS_NAMESPACE, 'locale'));

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
  ): void => {
    disposables.add(
      commands.register(id, (args) => handler(args as CommandArgsMap[K]), {
        title,
        public: true,
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
  register(
    'speech.speak',
    'Speak',
    async (args): Promise<SpeakCommandResult> => {
      const raw = args?.text !== undefined ? args.text.trim() : composition.commit();
      if (raw === '') return { spoken: false, text: '', recordId: null };
      const text = (await runTextTransforms('commit', raw)).trim();
      if (text === '') return { spoken: false, text: '', recordId: null };
      const record =
        args?.log === false ? null : conversation.append({ body: text, sender: 'user' });
      const recordId = record?.id ?? null;
      bus.emit('speech.requested', { text, recordId });
      if (!speech) return { spoken: false, text, recordId };
      speech.speak(text).catch((error: unknown) => reportError(error, 'speech.speak'));
      return { spoken: true, text, recordId };
    },
    ['speech.output'],
  );
  register('speech.stop', 'Stop speaking', () => {
    if (!speech) return false;
    speech.stop();
    return true;
  });
  register('gaze.pause', 'Pause gaze', () => {
    if (!gaze) return false;
    gaze.pause();
    bus.emit('gaze.pauseChanged', { paused: true });
    return true;
  });
  register('gaze.resume', 'Resume gaze', () => {
    if (!gaze) return false;
    gaze.resume();
    bus.emit('gaze.pauseChanged', { paused: false });
    return true;
  });

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
