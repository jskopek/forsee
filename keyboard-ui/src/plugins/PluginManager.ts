/**
 * Plugin Manager
 *
 * Manages plugin registration, lifecycle, and settings.
 * Provides context to plugins for LLM requests and app interaction.
 */

import Pusher from 'pusher-js';
import type {
  Plugin,
  PluginContext,
  LLMRequest,
  LLMStreamCallbacks,
} from './plugin-types';
import { llmRequest } from '../hooks/useLLM';

export class PluginManager {
  private plugins: Map<string, Plugin> = new Map();
  private settings: Map<string, Record<string, any>> = new Map();
  private pusher: Pusher | null = null;
  private conversationId: string | null;

  // App state getters (set by App component)
  private getCurrentText: () => string = () => '';
  private getKeyboardPrefix: () => string = () => '';
  private getSelectedHints: () => string[] = () => [];
  private getDwellTime: () => number = () => 1000;
  private speak: (text: string) => void = () => {};
  private addMessage: (body: string, sender: 'user' | 'contact') => Promise<void> = async () => {};

  constructor(conversationId: string | null, pusher: Pusher | null = null) {
    this.conversationId = conversationId;
    this.pusher = pusher;
    this.loadSettings();
  }

  /**
   * Set app state getters (called by App component)
   */
  setStateGetters(getters: {
    getCurrentText: () => string;
    getKeyboardPrefix: () => string;
    getSelectedHints: () => string[];
    getDwellTime: () => number;
    speak: (text: string) => void;
    addMessage: (body: string, sender: 'user' | 'contact') => Promise<void>;
  }) {
    this.getCurrentText = getters.getCurrentText;
    this.getKeyboardPrefix = getters.getKeyboardPrefix;
    this.getSelectedHints = getters.getSelectedHints;
    this.getDwellTime = getters.getDwellTime;
    this.speak = getters.speak;
    this.addMessage = getters.addMessage;
  }

  /**
   * Register a plugin
   */
  register(plugin: Plugin): void {
    this.plugins.set(plugin.metadata.id, plugin);

    // Load plugin settings from localStorage or use defaults
    const savedSettings = localStorage.getItem(`plugin_settings_${plugin.metadata.id}`);
    this.settings.set(
      plugin.metadata.id,
      savedSettings ? JSON.parse(savedSettings) : plugin.settings.defaults
    );

    console.log(`[PluginManager] Registered plugin: ${plugin.metadata.id}`);
  }

  /**
   * Unregister a plugin
   */
  unregister(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);
    if (plugin && plugin.onUnmount) {
      plugin.onUnmount();
    }
    this.plugins.delete(pluginId);
    console.log(`[PluginManager] Unregistered plugin: ${pluginId}`);
  }

  /**
   * Get all registered plugins
   */
  getAll(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get plugin by ID
   */
  get(id: string): Plugin | undefined {
    return this.plugins.get(id);
  }

  /**
   * Get plugin settings
   */
  getSettings(pluginId: string): Record<string, any> {
    return this.settings.get(pluginId) || {};
  }

  /**
   * Update plugin settings
   */
  updateSettings(pluginId: string, newSettings: Record<string, any>): void {
    this.settings.set(pluginId, newSettings);
    localStorage.setItem(`plugin_settings_${pluginId}`, JSON.stringify(newSettings));

    // Notify plugin of settings change
    const plugin = this.plugins.get(pluginId);
    if (plugin?.onSettingsChange) {
      plugin.onSettingsChange(newSettings, this.buildContext(pluginId));
    }

    console.log(`[PluginManager] Updated settings for plugin: ${pluginId}`);
  }

  /**
   * Generic LLM request helper
   */
  async llmRequestForPlugin(
    request: LLMRequest,
    callbacks: LLMStreamCallbacks
  ): Promise<string> {
    return llmRequest(request, callbacks, this.conversationId || undefined);
  }

  /**
   * Refresh other plugins (trigger their onMessageAdded handlers)
   */
  refreshOtherPlugins(pluginIds?: string[]): void {
    const pluginsToRefresh = pluginIds
      ? pluginIds.map(id => this.plugins.get(id)).filter(p => p)
      : Array.from(this.plugins.values());

    pluginsToRefresh.forEach(plugin => {
      if (plugin && plugin.onMessageAdded) {
        plugin.onMessageAdded(this.buildContext(plugin.metadata.id));
      }
    });
  }

  /**
   * Build plugin context
   */
  buildContext(pluginId: string): PluginContext {
    return {
      conversationId: this.conversationId,
      currentText: this.getCurrentText(),
      keyboardPrefix: this.getKeyboardPrefix(),
      selectedHints: this.getSelectedHints(),
      dwellTime: this.getDwellTime(),
      settings: this.getSettings(pluginId),
      llmRequest: this.llmRequestForPlugin.bind(this),
      refreshOtherPlugins: this.refreshOtherPlugins.bind(this),
      speak: this.speak.bind(this),
      addMessage: this.addMessage.bind(this),
    };
  }

  /**
   * Load settings from localStorage
   */
  private loadSettings(): void {
    // Settings are loaded lazily when plugins are registered
  }

  /**
   * Notify all plugins when a message is added
   */
  notifyMessageAdded(): void {
    this.plugins.forEach(plugin => {
      if (plugin.onMessageAdded) {
        plugin.onMessageAdded(this.buildContext(plugin.metadata.id));
      }
    });
  }

  /**
   * Mount all plugins (call onMount handlers)
   */
  mountAll(): void {
    this.plugins.forEach(plugin => {
      if (plugin.onMount) {
        plugin.onMount(this.buildContext(plugin.metadata.id));
      }
    });
  }

  /**
   * Unmount all plugins (call onUnmount handlers)
   */
  unmountAll(): void {
    this.plugins.forEach(plugin => {
      if (plugin.onUnmount) {
        plugin.onUnmount();
      }
    });
  }
}

export default PluginManager;
