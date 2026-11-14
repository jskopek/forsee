import {
  defaultErrorReporter,
  EventBus,
  ForseeError,
  toDisposable,
  type Disposable,
  type ErrorReporter,
  type ExtensionRegistry,
} from '@forsee/core';
import type { Voice, VoiceProvider } from '@forsee/plugin-api';
import { isVoiceProviderId } from './voices';

/** Events of `VoiceProviderRegistry`. */
export interface ProviderRegistryEventMap {
  changed: { readonly providerId: string; readonly change: 'added' | 'removed' };
}

interface Entry {
  readonly provider: VoiceProvider;
  readonly source: 'direct' | 'extension';
}

/**
 * The voice providers the engine can route to, in registration order.
 * Providers are added directly (`register`) or followed from the extension
 * registry's `voiceProviders` point (`follow`), so a plugin that contributes
 * a provider is usable at once, and unloading it removes it again.
 */
export class VoiceProviderRegistry implements Disposable {
  readonly events: EventBus<ProviderRegistryEventMap>;
  private readonly entries = new Map<string, Entry>();
  private readonly reportError: ErrorReporter;
  private readonly subscriptions: Disposable[] = [];

  constructor(options: { readonly reportError?: ErrorReporter } = {}) {
    this.reportError = options.reportError ?? defaultErrorReporter;
    this.events = new EventBus({ onListenerError: this.reportError });
  }

  /** Adds a provider. Throws `duplicate` when its id is taken. */
  register(provider: VoiceProvider): Disposable {
    return this.add(provider, 'direct');
  }

  get(providerId: string): VoiceProvider | undefined {
    return this.entries.get(providerId)?.provider;
  }

  list(): readonly VoiceProvider[] {
    return [...this.entries.values()].map((entry) => entry.provider);
  }

  /**
   * Mirrors the `voiceProviders` contributions of `extensions`, now and as
   * they change. A contribution whose id clashes with a direct provider is
   * reported and skipped.
   */
  follow(extensions: ExtensionRegistry): Disposable {
    const sync = (): void => {
      const wanted = new Map(
        extensions.list('voiceProviders').map((entry) => [entry.id, entry.contribution] as const),
      );
      for (const [id, entry] of [...this.entries]) {
        if (entry.source === 'extension' && wanted.get(id) !== entry.provider) this.remove(id);
      }
      for (const [id, provider] of wanted) {
        if (this.entries.has(id)) continue;
        try {
          this.add(provider, 'extension');
        } catch (error) {
          this.reportError(error, `speech.provider:${id}`);
        }
      }
    };
    sync();
    const subscription = extensions.events.on('changed', (change) => {
      if (change.point === 'voiceProviders') sync();
    });
    this.subscriptions.push(subscription);
    return subscription;
  }

  /**
   * Voices of every provider, in provider order. A provider that throws or
   * rejects is reported and skipped. Unless `includeNetwork`, only voices
   * flagged `local` are returned (the app must work offline).
   */
  async listVoices(options: { readonly includeNetwork?: boolean } = {}): Promise<Voice[]> {
    const providers = this.list();
    const lists = await Promise.all(
      providers.map(async (provider) => {
        try {
          return await provider.listVoices();
        } catch (error) {
          this.reportError(error, `speech.listVoices:${provider.id}`);
          return [];
        }
      }),
    );
    const voices: Voice[] = [];
    for (const list of lists) {
      for (const voice of list) {
        if (typeof voice !== 'object' || voice === null) continue;
        if (options.includeNetwork !== true && voice.local !== true) continue;
        voices.push(voice);
      }
    }
    return voices;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
    this.entries.clear();
    this.events.dispose();
  }

  private add(provider: VoiceProvider, source: Entry['source']): Disposable {
    const id = provider.id;
    // App providers have bare ids; plugin providers arrive as `<pluginId>/<localId>`.
    if (!isVoiceProviderId(id)) {
      throw new ForseeError('invalid-argument', `Invalid voice provider id: ${String(id)}`);
    }
    if (this.entries.has(id)) {
      throw new ForseeError('duplicate', `A voice provider with id ${id} is already registered`);
    }
    this.entries.set(id, { provider, source });
    this.events.emit('changed', { providerId: id, change: 'added' });
    return toDisposable(() => {
      if (this.entries.get(id)?.provider === provider) this.remove(id);
    });
  }

  private remove(id: string): void {
    if (!this.entries.delete(id)) return;
    this.events.emit('changed', { providerId: id, change: 'removed' });
  }
}
