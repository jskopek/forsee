/**
 * Plugin Manager
 *
 * Manages plugin registration, lifecycle, and settings.
 * Provides context to plugins for LLM requests and app interaction.
 */

import { llmRequest } from '../hooks/useLLM.ts';

export class PluginManager {
  constructor(conversationId, pusher = null) {
    this.plugins = new Map();
    this.settings = new Map();
    this.pusher = pusher;
    this.conversationId = conversationId;

    // App state getters (set by App component)
    this.getCurrentText = () => '';
    this.getKeyboardPrefix = () => '';
    this.getSelectedHints = () => [];
    this.getConversationTitle = () => '';
    this.getRecentMessages = () => [];
    this.getDwellTime = () => 1000;
    this.speak = () => {};
    this.addMessage = async () => {};
    this.setSelectedHints = () => {};
    
    this.loadSettings();
  }

  /**
   * Set app state getters (called by App component)
   */
  setStateGetters(getters: {
    getCurrentText: () => string;
    getKeyboardPrefix: () => string;
    getSelectedHints: () => string[];
    getConversationTitle: () => string;
    getRecentMessages: () => Array<{sender: string, body: string}>;
    getDwellTime: () => number;
    speak: (text: string) => void;
    addMessage: (body: string, sender: 'user' | 'contact') => Promise<void>;
    setSelectedHints: (updater: ((prev: string[]) => string[]) | string[]) => void;
  }) {
    this.getCurrentText = getters.getCurrentText;
    this.getKeyboardPrefix = getters.getKeyboardPrefix;
    this.getSelectedHints = getters.getSelectedHints;
    this.getConversationTitle = getters.getConversationTitle;
    this.getRecentMessages = getters.getRecentMessages;
    this.getDwellTime = getters.getDwellTime;
    this.speak = getters.speak;
    this.addMessage = getters.addMessage;
    this.setSelectedHints = getters.setSelectedHints;
  }

  /**
   * Register a plugin
   */
  register(plugin) {
    this.plugins.set(plugin.metadata.id, plugin);

    // Load plugin settings from localStorage or use defaults
    const savedSettings = localStorage.getItem(`plugin_settings_${plugin.metadata.id}`);
    this.settings.set(
      plugin.metadata.id,
      savedSettings ? JSON.parse(savedSettings) : plugin.settings.defaults
    );

  }

  /**
   * Unregister a plugin
   */
  unregister(pluginId) {
    const plugin = this.plugins.get(pluginId);
    if (plugin && plugin.onUnmount) {
      plugin.onUnmount();
    }
    this.plugins.delete(pluginId);
  }

  /**
   * Get all registered plugins
   */
  getAll() {
    return Array.from(this.plugins.values());
  }

  /**
   * Get plugin by ID
   */
  get(id) {
    return this.plugins.get(id);
  }

  /**
   * Get plugin settings
   */
  getSettings(pluginId) {
    return this.settings.get(pluginId) || {};
  }

  /**
   * Update plugin settings
   */
  updateSettings(pluginId, newSettings) {
    this.settings.set(pluginId, newSettings);
    localStorage.setItem(`plugin_settings_${pluginId}`, JSON.stringify(newSettings));

    // Notify plugin of settings change
    const plugin = this.plugins.get(pluginId);
    if (plugin?.onSettingsChange) {
      plugin.onSettingsChange(newSettings, this.buildContext(pluginId));
    }

  }

  /**
   * Generic LLM request helper
   */
  async llmRequestForPlugin(request, callbacks) {
    return llmRequest(request, callbacks, this.conversationId || undefined);
  }

  /**
   * Refresh other plugins (trigger their onMessageAdded handlers)
   */
  refreshOtherPlugins(pluginIds) {
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
  buildContext(pluginId) {
    return {
      conversationId: this.conversationId,
      conversationTitle: this.getConversationTitle(),
      recentMessages: this.getRecentMessages(),
      currentText: this.getCurrentText(),
      keyboardPrefix: this.getKeyboardPrefix(),
      selectedHints: this.getSelectedHints(),
      setSelectedHints: this.setSelectedHints,
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
  loadSettings() {
    // Settings are loaded lazily when plugins are registered
  }

  /**
   * Notify all plugins when a message is added
   */
  notifyMessageAdded() {
    this.plugins.forEach(plugin => {
      if (plugin.onMessageAdded) {
        plugin.onMessageAdded(this.buildContext(plugin.metadata.id));
      }
    });
  }

  /**
   * Mount all plugins (call onMount handlers)
   */
  mountAll() {
    this.plugins.forEach(plugin => {
      if (plugin.onMount) {
        plugin.onMount(this.buildContext(plugin.metadata.id));
      }
    });
  }

  /**
   * Unmount all plugins (call onUnmount handlers)
   */
  unmountAll() {
    this.plugins.forEach(plugin => {
      if (plugin.onUnmount) {
        plugin.onUnmount();
      }
    });
  }
}

export default PluginManager;
