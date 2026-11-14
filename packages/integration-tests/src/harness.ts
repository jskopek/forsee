/**
 * Test harness: a real kernel, the real speech engine (with a fake app voice
 * from `@forsee/speech/testing`), the real prediction engine and the real
 * plugin host, wired the way a shell wires them. Test-only code.
 */
import {
  createKernel,
  FakeClock,
  SequentialIdSource,
  type Kernel,
  type SpeechService,
} from '@forsee/core';
import { createMemoryHost } from '@forsee/host';
import { validateLayout } from '@forsee/layouts';
import {
  API_VERSION,
  type PermissionScope,
  type PluginManifest,
  type PluginModule,
} from '@forsee/plugin-api';
import {
  createPluginHost,
  type FirstPartyPlugin,
  type PluginHostInstance,
} from '@forsee/plugin-host';
import { ScriptedConsentPrompt } from '@forsee/plugin-host/testing';
import {
  createPredictionEngine,
  type PredictionEngine,
  type PredictionQuery,
} from '@forsee/prediction';
import { createSpeechEngine, type SpeechEngine } from '@forsee/speech';
import { FakeVoiceProvider, fakeVoice } from '@forsee/speech/testing';

/** Id of the app's own (fake) voice provider. */
export const APP_VOICE_PROVIDER = 'forsee.app-voice';

export interface Harness {
  readonly clock: FakeClock;
  readonly kernel: Kernel;
  readonly speech: SpeechEngine;
  /** The app's own voice; the default when no plugin voice is chosen. */
  readonly appVoice: FakeVoiceProvider;
  readonly prediction: PredictionEngine;
  readonly plugins: PluginHostInstance;
  readonly errors: { readonly error: unknown; readonly context: string }[];
  /** A prediction query for the current composition, as the keyboard view would build it. */
  query(): PredictionQuery;
}

export interface HarnessOptions {
  readonly firstParty?: readonly FirstPartyPlugin[];
  /** Runs after the kernel has started and before any plugin is activated. */
  readonly beforePlugins?: (kernel: Kernel) => Promise<void>;
}

/** Lets pending promise callbacks run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** A first-party plugin with the given id, permissions and module. */
export function firstParty(
  id: string,
  permissions: readonly PermissionScope[],
  module: PluginModule,
  extra: Partial<PluginManifest> = {},
): FirstPartyPlugin {
  return {
    manifest: {
      id,
      name: id,
      version: '1.0.0',
      apiVersion: API_VERSION,
      minAppVersion: '0.0.0',
      description: 'Integration test plugin.',
      author: 'Tests',
      permissions,
      ...extra,
    },
    module,
  };
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = new FakeClock({ wall: Date.UTC(2026, 10, 14, 12) });
  const ids = new SequentialIdSource();
  const errors: { error: unknown; context: string }[] = [];
  const reportError = (error: unknown, context: string): void => {
    errors.push({ error, context });
  };

  // The kernel needs the speech service and the speech engine needs the
  // kernel's extension registry, so the kernel gets a forwarding service.
  const late: { engine?: SpeechEngine } = {};
  const speechService: SpeechService = {
    speak: (text, speakOptions) =>
      late.engine ? late.engine.speak(text, speakOptions) : Promise.resolve('error'),
    stop: () => late.engine?.stop(),
    isAvailable: () => late.engine?.isAvailable() ?? false,
  };
  const kernel = createKernel({
    clock,
    ids,
    deviceId: 'device-1',
    speech: speechService,
    reportError,
  });
  const appVoice = new FakeVoiceProvider({
    id: APP_VOICE_PROVIDER,
    clock,
    voices: [fakeVoice(APP_VOICE_PROVIDER, 'default', 'en-GB', { isDefault: true })],
  });
  const speech = createSpeechEngine({
    clock,
    newId: () => ids.uuid(),
    extensions: kernel.extensions,
    providers: [appVoice],
    defaultProviderId: APP_VOICE_PROVIDER,
    reportError,
  });
  late.engine = speech;

  const prediction = createPredictionEngine({
    extensions: kernel.extensions,
    reportError,
    context: () => kernel.context.list(),
    // Everything is offered; what a plugin provider may see is decided by
    // the plugin host's wrapper alone, which is what these tests exercise.
    access: () => ({ conversation: true, context: true, learn: true }),
  });

  await kernel.start();
  await options.beforePlugins?.(kernel);

  const plugins = createPluginHost({
    kernel,
    host: createMemoryHost({ clock, platform: { appVersion: '1.0.0', shell: 'web' } }),
    firstParty: options.firstParty ?? [],
    validateLayout,
    consent: new ScriptedConsentPrompt(true),
    services: {
      listVoices: () => speech.listVoices(),
      speechEvents: (listener) => speech.events.on('speech', listener),
    },
    reportError,
  });
  await plugins.start();

  const query = (): PredictionQuery => {
    const state = kernel.composition.state;
    return {
      textBefore: state.textBeforeCaret,
      partialWord: state.partialWord,
      partialWordSteps: state.partialWordSteps,
      locale: kernel.locale,
      maxCandidates: 5,
      kinds: ['completions', 'nextWords', 'letters', 'phrases'],
      conversation: {
        recent: kernel.conversation
          .listRecent(10)
          .map(({ sender, body, createdAt }) => ({ sender, body, createdAt })),
      },
    };
  };

  return { clock, kernel, speech, appVoice, prediction, plugins, errors, query };
}
