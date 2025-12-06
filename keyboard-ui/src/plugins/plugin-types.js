/**
 * Plugin Architecture Type Definitions
 *
 * This file defines the interfaces for creating plugins in the Forsee keyboard UI.
 * Plugins are self-contained modules that can request LLM completions without
 * knowing about providers or models - the server handles that.
 */

// ============================================================================
// PLUGIN METADATA
// ============================================================================

export interface PluginMetadata {
  id: string;                    // Unique plugin identifier (e.g., "builtin.suggestions")
  name: string;                  // Display name
  description: string;           // Brief description
  version: string;               // Semantic version
  author: string;                // Plugin author
  icon?: string;                 // Optional icon/emoji
}

// ============================================================================
// PLUGIN SETTINGS
// ============================================================================

export interface SettingField {
  key: string;                   // Setting identifier
  label: string;                 // Display label
  type: 'string' | 'number' | 'boolean' | 'select' | 'range';
  description?: string;          // Help text
  default: any;                  // Default value
  options?: Array<{label: string, value: any}>; // For select type
  min?: number;                  // For number/range
  max?: number;                  // For number/range
  step?: number;                 // For range
}

export interface PluginSettings {
  schema: SettingField[];        // Array of setting definitions
  defaults: Record<string, any>; // Default values
}

// ============================================================================
// LLM REQUEST/RESPONSE
// ============================================================================

export interface LLMRequest {
  prompt: string;                  // Combined system + user prompt
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, any>;
  }>;
  temperature?: number;            // Defaults to 0.7
  maxTokens?: number;              // Defaults to 500
  // NOTE: No provider or model - server decides based on configuration
}

export interface LLMStreamCallbacks {
  onToken?: (token: string) => void;
  onToolCall?: (toolName: string, args: Record<string, any>) => void;
  onComplete?: (usage?: {prompt_tokens?: number, completion_tokens?: number}) => void;
  onError?: (error: string) => void;
}

// ============================================================================
// PLUGIN CONTEXT
// ============================================================================

export interface PluginContext {
  conversationId: string | null;
  currentText: string;          // Current suggestion text
  keyboardPrefix: string;       // Typed prefix
  selectedHints: string[];      // Selected hint words
  dwellTime: number;            // Hover delay (ms)
  settings: Record<string, any>; // Plugin's current settings
  llmRequest: (request: LLMRequest, callbacks: LLMStreamCallbacks) => Promise<string>;
  refreshOtherPlugins: (pluginIds?: string[]) => void;
  speak: (text: string) => void;
  addMessage: (body: string, sender: 'user' | 'contact') => Promise<void>;
}

// ============================================================================
// PLUGIN COMPONENT
// ============================================================================

export interface PluginComponentProps {
  context: PluginContext;
  panelState: 'expanded' | 'collapsed';
  onTogglePanel: () => void;
}

// ============================================================================
// PLUGIN INTERFACE
// ============================================================================

export interface Plugin {
  metadata: PluginMetadata;
  settings: PluginSettings;
  Component: React.ComponentType<PluginComponentProps>;
  onMount?: (context: PluginContext) => void;
  onUnmount?: () => void;
  onSettingsChange?: (newSettings: Record<string, any>, context: PluginContext) => void;
  onMessageAdded?: (context: PluginContext) => void; // Called when new message added
}
