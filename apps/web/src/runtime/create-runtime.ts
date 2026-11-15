import {
  createKernel,
  DisposableStore,
  GENERAL_SETTINGS_NAMESPACE,
  NOOP_DISPOSABLE,
  type ErrorReporter,
  type GazeControl,
  type Kernel,
  type SpeechService,
} from '@forsee/core';
import {
  adjustDwell,
  createGazePipeline,
  createTargetRegistry,
  dwellConfigToSettings,
  GAZE_SETTING_FIELDS,
  GAZE_SETTINGS_NAMESPACE,
  gazeConfigFromSettings,
  type GazePipeline,
  type GazeSettingsConfig,
} from '@forsee/gaze';
import {
  createAutoPointerSource,
  selectionMethodForMode,
  type AutoPointerSource,
} from '@forsee/gaze-web';
import { createWebHost } from '@forsee/host';
import { validateLayout } from '@forsee/layouts';
import type { LearnEvent, SelectionMethodId, SpeakCommandResult } from '@forsee/plugin-api';
import {
  createPluginHost,
  PLUGIN_SETTINGS_NAMESPACE,
  predictionAccess,
  type ConsentPrompt,
  type PluginHostInstance,
} from '@forsee/plugin-host';
import { createPredictionEngine, stabiliseCandidates } from '@forsee/prediction';
import {
  createRecordedMessageProvider,
  createSpeakModeController,
  createSpeechService,
  createWebSpeechProvider,
  type SpeakModeController,
  type VoiceProvider,
  type WebSpeechProvider,
} from '@forsee/speech';
import { browserAudioPlayer, browserLifecycle, browserSpeechSynthesis } from './browser';
import { createErrorCollector } from './errors';
import { defaultFirstPartyPlugins } from './first-party';
import { createLayoutController } from './layout';
import {
  defaultStorage,
  openHostAndProfile,
  profileConsentStorage,
  profileInstallStorage,
} from './profile-storage';
import {
  LAYOUT_SETTING_FIELDS,
  LAYOUT_SETTINGS_NAMESPACE,
  SPEECH_SETTING_FIELDS,
  SPEECH_SETTINGS_NAMESPACE,
  speakModeOf,
  UI_SETTING_FIELDS,
  UI_SETTINGS_NAMESPACE,
} from './settings';
import type {
  ForseeRuntime,
  ForseeRuntimeOptions,
  RuntimeGaze,
  RuntimeSpeech,
  RuntimeSpeechSettings,
  StartupIssue,
} from './types';

/** Commands the runtime registers for the in-place dwell keys. */
export const DWELL_FASTER_COMMAND = 'gaze.dwellFaster';
export const DWELL_SLOWER_COMMAND = 'gaze.dwellSlower';

/** Until a consent screen exists, community plugins are refused (first-party plugins need no prompt). */
const REFUSE_CONSENT: ConsentPrompt = { ask: () => Promise.resolve(false) };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultOnError(): ((error: { error: unknown; context: string }) => void) | undefined {
  const c = (globalThis as { console?: { error(...args: unknown[]): void } }).console;
  if (typeof window === 'undefined' || !c) return undefined;
  return (entry) => c.error(`[forsee] ${entry.context}`, entry.error);
}

/**
 * Boots a complete Forsee: profile storage, kernel, speech, prediction,
 * plugins, gaze input and the active layout, wired together. Every browser
 * dependency comes from `options` (real browser by default), so the whole
 * runtime runs in Node tests.
 *
 * Each optional part starts in isolation: if speech, the plugins, gaze input
 * or the lifecycle hooks fail, the failure is reported (`errors`,
 * `startupIssues`) and the app starts with what works. Only a failure to
 * open even an in-memory profile rejects; a broken or missing persistent
 * store falls back to memory with `profile.warning` set.
 */
export async function createForseeRuntime(
  options: ForseeRuntimeOptions = {},
): Promise<ForseeRuntime> {
  const appVersion = options.appVersion ?? '0.0.0';
  const issues: StartupIssue[] = [];
  /** Teardown steps in boot order; `dispose` runs them in reverse. */
  const teardown: [string, () => void][] = [];
  const onDispose = (name: string, step: () => void): void => {
    teardown.push([name, step]);
  };

  // ---------------------------------------------------------------- errors
  const clockRef: { wallNow?: () => number } = {};
  const collector = createErrorCollector({
    wallNow: () => clockRef.wallNow?.() ?? 0,
    ...(options.onError
      ? { onError: options.onError }
      : (() => {
          const sink = defaultOnError();
          return sink ? { onError: sink } : {};
        })()),
  });
  const reportError: ErrorReporter = collector.report;
  const issue = (part: StartupIssue['part'], error: unknown): void => {
    reportError(error, `runtime.start.${part}`);
    issues.push({ part, message: messageOf(error) });
  };

  // ---------------------------------------------------------------- 1. host and storage
  const opened = await openHostAndProfile({
    storage: options.storage ?? defaultStorage(reportError),
    createHost:
      options.createHost ??
      ((files, persistent) => createWebHost({ files, persistent, appVersion })),
    appVersion,
    reportError,
  });
  const { host, storage } = opened;
  const profile = opened.opened.store;
  const { clock, ids } = host;
  clockRef.wallNow = () => clock.wallNow();
  if (opened.warning) issues.push({ part: 'storage', message: opened.warning });
  onDispose('host', () => host.dispose());

  // ---------------------------------------------------------------- 2. kernel
  // The kernel needs the speech service and gaze control; the speech engine
  // and gaze pipeline need the kernel. The kernel gets forwarding objects
  // that reach them once they exist (and do nothing if they failed to start).
  const late: { speech?: SpeechService; gaze?: GazePipeline } = {};
  const speechService: SpeechService = {
    speak: (text, speakOptions) =>
      late.speech ? late.speech.speak(text, speakOptions) : Promise.resolve('error'),
    stop: () => late.speech?.stop(),
    isAvailable: () => late.speech?.isAvailable?.() ?? false,
  };
  const gazeControl: GazeControl = {
    get paused() {
      return late.gaze?.paused ?? false;
    },
    pause: () => late.gaze?.pause(),
    resume: () => late.gaze?.resume(),
  };
  const kernel: Kernel = createKernel({
    clock,
    ids,
    deviceId: profile.metadata.deviceId,
    persistence: {
      settings: profile.settings,
      conversation: profile.history,
      composition: profile.composition,
    },
    speech: speechService,
    gaze: gazeControl,
    reportError,
    // A speech keyboard has no Shift on its letters page: capitals come by themselves.
    defaultAutoCapitalise: true,
    ...(options.defaultLocale === undefined ? {} : { defaultLocale: options.defaultLocale }),
  });
  onDispose('kernel', () => kernel.dispose());
  // Schemas first, so stored values are validated and applied as they load.
  kernel.settings.registerSchema(SPEECH_SETTINGS_NAMESPACE, SPEECH_SETTING_FIELDS);
  kernel.settings.registerSchema(LAYOUT_SETTINGS_NAMESPACE, LAYOUT_SETTING_FIELDS);
  kernel.settings.registerSchema(GAZE_SETTINGS_NAMESPACE, GAZE_SETTING_FIELDS);
  kernel.settings.registerSchema(UI_SETTINGS_NAMESPACE, UI_SETTING_FIELDS);
  await kernel.start();

  // ---------------------------------------------------------------- 3. speech
  const synthesisEnv =
    options.speechSynthesis === undefined ? browserSpeechSynthesis() : options.speechSynthesis;
  const player = options.audioPlayer === undefined ? browserAudioPlayer() : options.audioPlayer;
  let webSpeech: WebSpeechProvider | null = null;
  const providers: VoiceProvider[] = [];
  try {
    if (synthesisEnv) {
      webSpeech = createWebSpeechProvider({
        synthesis: synthesisEnv.synthesis,
        createUtterance: synthesisEnv.createUtterance,
        clock,
        ...(options.speechRequiresUnlock ? { requireUnlock: true } : {}),
      });
      providers.push(webSpeech);
      const provider = webSpeech;
      onDispose('speech.web', () => provider.dispose());
    }
    if (player) {
      providers.push(
        createRecordedMessageProvider({
          readFile: (path) => profile.files.readBytes(path),
          player,
          clock,
        }),
      );
    }
  } catch (error) {
    issue('speech', error);
  }
  const speechEngine = createSpeechService({
    clock,
    newId: () => ids.uuid(),
    extensions: kernel.extensions,
    providers,
    ...(webSpeech ? { defaultProviderId: webSpeech.id } : {}),
    locale: kernel.locale,
    reportError,
  });
  onDispose('speech.engine', () => speechEngine.dispose());
  late.speech = speechEngine;
  if (!synthesisEnv) {
    issues.push({ part: 'speech', message: 'This browser has no speech synthesis.' });
  }

  const readSpeechSettings = (): RuntimeSpeechSettings => {
    const all = kernel.settings.getAll(SPEECH_SETTINGS_NAMESPACE);
    return {
      voiceId: String(all.voiceId),
      rate: Number(all.rate),
      pitch: Number(all.pitch),
      volume: Number(all.volume),
      speakMode: speakModeOf(all.speakMode),
    };
  };
  let speakMode: SpeakModeController | null = null;
  const applySpeechSettings = (): void => {
    const s = readSpeechSettings();
    speechEngine.updateSettings({
      voiceId: s.voiceId === '' ? undefined : s.voiceId,
      locale: kernel.locale,
      rate: s.rate,
      pitch: s.pitch,
      volume: s.volume,
    });
    speakMode?.setMode(s.speakMode);
  };
  try {
    speakMode = createSpeakModeController({
      composition: kernel.composition,
      speech: speechEngine,
      mode: readSpeechSettings().speakMode,
      reportError,
    });
    const controller = speakMode;
    onDispose('speech.mode', () => controller.dispose());
  } catch (error) {
    issue('speech', error);
  }
  applySpeechSettings();
  const speechSubscription = kernel.settings.events.on('changed', (change) => {
    if (
      change.namespace === SPEECH_SETTINGS_NAMESPACE ||
      (change.namespace === GENERAL_SETTINGS_NAMESPACE && change.key === 'locale')
    ) {
      applySpeechSettings();
    }
  });
  onDispose('speech.settings', () => speechSubscription.dispose());

  // ---------------------------------------------------------------- 4. prediction
  // What each provider may see comes from the plugin host's permissions once
  // it exists (app-owned providers get everything).
  let access: (contribution: { readonly owner: string }) => {
    conversation: boolean;
    context: boolean;
    learn: boolean;
  } = ({ owner }) => {
    const app = owner === 'app';
    return { conversation: app, context: app, learn: app };
  };
  const prediction = createPredictionEngine({
    extensions: kernel.extensions,
    clock,
    reportError,
    context: () => kernel.context.list(),
    access: (contribution) => access(contribution),
  });
  onDispose('prediction', () => prediction.dispose());

  // The user's words are learned when they are spoken and logged (not when
  // `log: false`, which the app uses for its own announcements).
  const pendingLearns = new Set<Promise<void>>();
  const learnSubscription = kernel.bus.on('command.didExecute', ({ id, result }) => {
    if (id !== 'composition.speak' && id !== 'speech.speak') return;
    const spoken = result as SpeakCommandResult | undefined;
    if (!spoken || spoken.text === '' || spoken.recordId === null) return;
    const event: LearnEvent = {
      text: spoken.text,
      origin: id === 'composition.speak' ? 'composition' : 'phrase',
      locale: kernel.locale,
      createdAt: clock.wallNow(),
    };
    const learning = prediction.learn(event).catch((error: unknown) => {
      reportError(error, 'runtime.learn');
    });
    pendingLearns.add(learning);
    void learning.finally(() => pendingLearns.delete(learning));
  });
  onDispose('prediction.learn', () => learnSubscription.dispose());

  // ---------------------------------------------------------------- 5. plugins
  const firstParty = (options.firstPartyPlugins ?? defaultFirstPartyPlugins)({
    clock,
    locale: kernel.locale,
  });
  const pluginHost: PluginHostInstance = createPluginHost({
    kernel,
    host,
    firstParty,
    validateLayout,
    consent: options.consent ?? REFUSE_CONSENT,
    consentStorage: profileConsentStorage(profile),
    installStorage: profileInstallStorage(profile),
    pluginStorage: (pluginId) => profile.pluginData(pluginId),
    services: {
      listVoices: () => speechEngine.listVoices(),
      speechEvents: (listener) => speechEngine.events.on('speech', listener),
    },
    appVersion,
    reportError,
  });
  onDispose('plugins', () => pluginHost.dispose());
  access = predictionAccess(pluginHost.permissions);
  try {
    await pluginHost.start();
    // A first-party plugin that did not start is part of the app missing
    // (failed in activate, or blocked, for example by its minAppVersion).
    for (const status of pluginHost.list()) {
      if (
        status.origin === 'first-party' &&
        (status.state === 'failed' || status.state === 'blocked')
      ) {
        issues.push({
          part: 'plugins',
          message: `${status.manifest.name} (${status.manifest.id}) is ${status.state}: ${status.reason ?? 'no reason given'}`,
        });
      }
    }
  } catch (error) {
    issue('plugins', error);
  }

  // ---------------------------------------------------------------- 6. gaze
  const gazeSubscriptions = new DisposableStore();
  onDispose('gaze.subscriptions', () => gazeSubscriptions.dispose());
  const readGazeSettings = (): GazeSettingsConfig => {
    try {
      return gazeConfigFromSettings(kernel.settings.getAll(GAZE_SETTINGS_NAMESPACE));
    } catch (error) {
      reportError(error, 'runtime.gaze.settings');
      return gazeConfigFromSettings({});
    }
  };
  let gazeSettings = readGazeSettings();
  const targets = createTargetRegistry({ config: gazeSettings.hitTest, reportError });
  const pipeline = createGazePipeline({
    clock,
    targets,
    dwell: gazeSettings.dwell,
    executeCommand: (command, args, source) =>
      kernel.commands.execute(command, args as never, source),
    method: gazeSettings.method,
    engine: gazeSettings.engine,
    reportError,
  });
  onDispose('gaze.pipeline', () => pipeline.dispose());
  late.gaze = pipeline;

  let pointer: AutoPointerSource | null = null;
  const wantedMethod = (): SelectionMethodId => {
    const mode = pointer?.mode;
    // Touch has no hover, so it selects directly; otherwise the user's method.
    return mode === 'tap' ? selectionMethodForMode('tap') : gazeSettings.method;
  };
  const applyMethod = (): void => {
    const method = wantedMethod();
    if (pipeline.selectionMethod !== method) pipeline.setSelectionMethod(method);
  };
  gazeSubscriptions.add(
    kernel.settings.events.on('changed', (change) => {
      if (change.namespace !== GAZE_SETTINGS_NAMESPACE) return;
      try {
        gazeSettings = readGazeSettings();
        if (change.key.startsWith('dwell.')) pipeline.setDwellConfig(gazeSettings.dwell);
        if (change.key.startsWith('targets.')) targets.setHitTestConfig(gazeSettings.hitTest);
        if (change.key.startsWith('filter.')) pipeline.setEngineConfig(gazeSettings.engine);
        applyMethod();
      } catch (error) {
        reportError(error, 'runtime.gaze.settings');
      }
    }),
  );
  try {
    pointer = createAutoPointerSource({
      clock,
      ...(options.pointerEnvironment ? { environment: options.pointerEnvironment } : {}),
    });
    gazeSubscriptions.add(pointer.onModeChange(() => applyMethod()));
    gazeSubscriptions.add(
      pipeline.onSourceError((error) => reportError(error, 'runtime.gaze.source')),
    );
    pipeline.setSource(pointer.source);
    onDispose('gaze.source', () => pipeline.setSource(null));
  } catch (error) {
    issue('gaze', error);
  }

  const adjust = async (direction: 'faster' | 'slower'): Promise<void> => {
    const result = adjustDwell(pipeline.dwellConfig, { direction });
    const values = dwellConfigToSettings(result.config);
    for (const [key, value] of Object.entries(values)) {
      if (kernel.settings.get(GAZE_SETTINGS_NAMESPACE, key) !== value) {
        kernel.settings.set(GAZE_SETTINGS_NAMESPACE, key, value);
      }
    }
    // Say the new value (not logged, so it is neither history nor learned).
    if (speechEngine.isAvailable()) {
      const seconds = (result.config.classMs.letter / 1000).toFixed(1);
      await kernel.commands.execute(
        'speech.speak',
        { text: `Dwell ${seconds} seconds`, log: false, interrupt: true },
        'app',
      );
    }
  };
  for (const [id, direction, title] of [
    [DWELL_FASTER_COMMAND, 'faster', 'Faster dwell'],
    [DWELL_SLOWER_COMMAND, 'slower', 'Slower dwell'],
  ] as const) {
    // Not public: dwell speed is input control, like pausing.
    gazeSubscriptions.add(
      kernel.commands.register(id, () => adjust(direction), { title, public: false }),
    );
  }

  const gaze: RuntimeGaze = {
    pipeline,
    targets,
    get inputMode() {
      return pointer?.mode ?? null;
    },
    get selectionMethod() {
      return pipeline.selectionMethod;
    },
    onInputModeChange: (listener) => pointer?.onModeChange(listener) ?? NOOP_DISPOSABLE,
    adjustDwell: async (direction) => {
      await kernel.commands.execute(
        direction === 'faster' ? DWELL_FASTER_COMMAND : DWELL_SLOWER_COMMAND,
        undefined,
        'app',
      );
    },
    pause: async () => {
      await kernel.commands.execute('gaze.pause', undefined, 'app');
    },
    resume: async () => {
      await kernel.commands.execute('gaze.resume', undefined, 'app');
    },
  };

  // ---------------------------------------------------------------- 7. layout
  const layout = createLayoutController(kernel, reportError);
  onDispose('layout', () => layout.dispose());

  // ---------------------------------------------------------------- 8. lifecycle
  const flush = async (): Promise<void> => {
    await Promise.all([...pendingLearns]);
    const steps: [string, () => Promise<void>][] = [
      ['kernel', () => kernel.flush()],
      ['consent', () => pluginHost.permissions.flush()],
      ['profile', () => profile.flush()],
    ];
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (error) {
        reportError(error, `runtime.flush.${name}`);
      }
    }
  };

  const lifecycle = options.lifecycle === undefined ? browserLifecycle() : options.lifecycle;
  if (lifecycle) {
    try {
      const flushNow = (): void => {
        void flush();
      };
      const onVisibility = (): void => {
        if (lifecycle.document?.visibilityState === 'hidden') flushNow();
      };
      lifecycle.window?.addEventListener('pagehide', flushNow);
      lifecycle.document?.addEventListener('visibilitychange', onVisibility);
      onDispose('lifecycle', () => {
        lifecycle.window?.removeEventListener('pagehide', flushNow);
        lifecycle.document?.removeEventListener('visibilitychange', onVisibility);
      });
    } catch (error) {
      issue('lifecycle', error);
    }
  }

  // ---------------------------------------------------------------- the runtime
  const speech: RuntimeSpeech = {
    engine: speechEngine,
    get available() {
      return speechEngine.isAvailable();
    },
    get locked() {
      return webSpeech?.locked ?? false;
    },
    unlock: () => webSpeech?.unlock(),
    onLockedChange: (listener) => webSpeech?.onLockedChange(listener) ?? NOOP_DISPOSABLE,
    onUnavailable: (listener) => kernel.bus.on('speech.unavailable', listener),
    listVoices: () => speechEngine.listVoices(),
    get settings() {
      return readSpeechSettings();
    },
    updateSettings(patch) {
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) kernel.settings.set(SPEECH_SETTINGS_NAMESPACE, key, value);
      }
    },
  };

  let disposing: Promise<void> | null = null;
  const runtime: ForseeRuntime = {
    hostUi: { kernel, gaze: pipeline, prediction, stabiliseCandidates },
    kernel,
    host,
    profile: {
      id: profile.metadata.id,
      name: profile.metadata.name,
      deviceId: profile.metadata.deviceId,
      created: opened.opened.created,
      storage: storage.kind,
      persistent: storage.persistent,
      ...(opened.warning === undefined ? {} : { warning: opened.warning }),
    },
    speech,
    gaze,
    prediction,
    layout,
    settings: {
      namespaces: {
        general: GENERAL_SETTINGS_NAMESPACE,
        speech: SPEECH_SETTINGS_NAMESPACE,
        gaze: GAZE_SETTINGS_NAMESPACE,
        layout: LAYOUT_SETTINGS_NAMESPACE,
        ui: UI_SETTINGS_NAMESPACE,
        plugins: PLUGIN_SETTINGS_NAMESPACE,
      },
      get: (namespace, key) => kernel.settings.get(namespace, key),
      set: (namespace, key, value) => kernel.settings.set(namespace, key, value),
    },
    pluginHost,
    errors: collector.errors,
    reportError,
    startupIssues: issues,
    flush,
    dispose() {
      disposing ??= (async () => {
        await flush();
        for (const [name, step] of teardown.reverse()) {
          try {
            step();
          } catch (error) {
            reportError(error, `runtime.dispose.${name}`);
          }
        }
        collector.dispose();
      })();
      return disposing;
    },
  };
  return runtime;
}
