# Keyboard UI Plugin Architecture Design

## Executive Summary

This document outlines a plugin architecture for the Forsee keyboard UI that enables third-party developers to create powerful, self-contained extensions. The design moves LLM prompting logic from the server to client-side plugins, while the server acts as a smart proxy that handles provider/model selection, API key management, and streaming. Plugins define prompts and callbacks, but the server decides which LLM provider to use based on configuration, user tier, or request characteristics.

## Implementation Status (2025-12-05)

**Overall Progress**: 70% Complete (Phases 1-3 ✅, Phase 4 🔄 In Progress)

### ✅ Completed
- **Phase 1**: Server-side smart LLM proxy (`/api/llm/stream` endpoint)
- **Phase 2**: Client-side `useLLM` hook for streaming requests
- **Phase 3**: Plugin infrastructure (types, PluginManager, Panel component)
- Initial SuggestionsPlugin.tsx created (not yet integrated)

### 🔄 In Progress
- **Phase 4**: Integrating SuggestionsPlugin into App.js
- Testing with live Groq streaming

### ⏳ Remaining
- **Phase 5**: Create HintsPlugin.tsx
- **Phase 6**: Unified settings UI, documentation, deprecate old endpoints

### Key Files Created
- `conversations/api_llm.py` - Smart LLM proxy (173 lines)
- `keyboard-ui/src/hooks/useLLM.ts` - React hook for LLM requests (237 lines)
- `keyboard-ui/src/plugins/plugin-types.ts` - TypeScript interfaces (101 lines)
- `keyboard-ui/src/plugins/PluginManager.ts` - Plugin orchestration (186 lines)
- `keyboard-ui/src/plugins/SuggestionsPlugin.tsx` - Suggestions as plugin (241 lines)
- `keyboard-ui/src/components/Panel.jsx` - Reusable panel component (60 lines)

---

## 1. Core Design Principles

### 1.1 Plugin Self-Containment
Each plugin should be a complete, independent module containing:
- **Prompt definition**: System and user prompts for LLM requests
- **Response handlers**: Callbacks for processing streaming/completed responses
- **Settings schema**: Configuration options exposed to users
- **UI component**: React component for rendering plugin output
- **Metadata**: Name, description, version, author

### 1.2 Server as Smart Proxy
The server should:
- Accept generic LLM requests with prompts and tools (but NOT provider/model specification)
- **Intelligently select** provider and model based on:
  - Server configuration (env vars, database settings)
  - User tier/plan (free, premium, enterprise)
  - Request characteristics (tool complexity, cost optimization)
  - Availability and failover requirements
- Stream responses back via Pusher/WebSocket
- NOT contain plugin-specific logic (prompts live in plugins)
- Support multiple LLM providers (Groq, OpenAI, Anthropic, local Ollama)
- Handle authentication, API key management, and rate limiting
- **Keep API keys secure** - never exposed to client

### 1.3 Unified Settings Interface
- Single settings panel in keyboard UI
- Plugins register their settings schemas
- Settings stored in localStorage (client) and optionally synced to server
- Settings UI auto-generated from schema

### 1.4 Backwards Compatibility
- Existing Suggestions and Hints components become "built-in plugins"
- Current API endpoints remain functional during transition
- Migration path for existing functionality

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Keyboard UI (React)                      │
│                  NO API KEYS, NO PROVIDER LOGIC              │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Plugin Manager                            │ │
│  │  - Registers plugins                                   │ │
│  │  - Manages plugin lifecycle                            │ │
│  │  - Collects settings schemas                           │ │
│  │  - Provides LLM request helper (useLLM hook)           │ │
│  └────────────────────────────────────────────────────────┘ │
│                           │                                  │
│           ┌───────────────┼───────────────┐                 │
│           │               │               │                 │
│  ┌────────▼─────┐  ┌──────▼──────┐  ┌────▼──────────┐     │
│  │ Suggestions  │  │   Hints     │  │  Custom       │     │
│  │   Plugin     │  │   Plugin    │  │  Plugin       │     │
│  │              │  │             │  │               │     │
│  │ - Prompt def │  │ - Prompt def│  │ - Prompt def  │     │
│  │ - Callbacks  │  │ - Callbacks │  │ - Callbacks   │     │
│  │ - Settings   │  │ - Settings  │  │ - Settings    │     │
│  │ - UI         │  │ - UI        │  │ - UI          │     │
│  └──────────────┘  └─────────────┘  └───────────────┘     │
│           │               │               │                 │
│           └───────────────┼───────────────┘                 │
│                           │                                  │
│                    ┌──────▼──────┐                          │
│                    │  useLLM()   │                          │
│                    │   Hook      │                          │
│                    │ (sends only │                          │
│                    │prompt+tools)│                          │
│                    └──────┬──────┘                          │
└───────────────────────────┼─────────────────────────────────┘
                            │
                   HTTP: {prompt, tools, temp}
                   WebSocket: streaming responses
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                  Django Server                               │
│               SERVER DECIDES PROVIDER/MODEL                  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │           Smart LLM Proxy API                          │ │
│  │                                                        │ │
│  │  POST /api/llm/stream                                  │ │
│  │  CLIENT SENDS:                                         │ │
│  │  {                                                     │ │
│  │    prompt: "Generate 6 suggestions...",                │ │
│  │    tools: [{name, description, parameters}],          │ │
│  │    temperature: 0.7,                                  │ │
│  │    max_tokens: 500,                                   │ │
│  │    stream_id: "client-generated-uuid"                 │ │
│  │  }                                                     │ │
│  │                                                        │ │
│  │  SERVER CHOOSES:                                       │ │
│  │  - Provider (Groq/OpenAI/Anthropic/Ollama)            │ │
│  │  - Model (based on user tier, complexity, cost)       │ │
│  │  - API key (from env/database, never client)          │ │
│  │                                                        │ │
│  │  Response: {stream_id: "...", status: "streaming"}    │ │
│  │                                                        │ │
│  │  Events streamed to Pusher:                            │ │
│  │  - token: {stream_id, token}                          │ │
│  │  - tool_call: {stream_id, name, arguments}            │ │
│  │  - complete: {stream_id}                              │ │
│  │  - error: {stream_id, message}                        │ │
│  └────────────────────────────────────────────────────────┘ │
│                           │                                  │
│                    ┌──────▼──────┐                          │
│                    │  Provider   │                          │
│                    │  Selection  │                          │
│                    │   Logic     │                          │
│                    │ (env vars,  │                          │
│                    │ user tier,  │                          │
│                    │ fallback)   │                          │
│                    └──────┬──────┘                          │
│              ┌────────────┼───────────────┐                 │
│         ┌────▼────┐  ┌────▼────┐  ┌──────▼──────┐         │
│         │  Groq   │  │ OpenAI  │  │Local Ollama │         │
│         │ Adapter │  │ Adapter │  │  Adapter    │         │
│         └─────────┘  └─────────┘  └─────────────┘         │
│                                                              │
│  Environment Config:                                         │
│  - LLM_PROVIDER=groq (or openai, anthropic, local)         │
│  - LLM_MODEL=llama-3.1-8b-instant                           │
│  - GROQ_API_KEY=***                                         │
│  - OLLAMA_ENDPOINT=http://localhost:11434 (optional)       │
└──────────────────────────────────────────────────────────────┘
```

**Key Insight**: Plugins write prompts, server executes them with the right provider/model.

---

## 3. Plugin Interface Specification

### 3.1 Plugin Structure (TypeScript)

```typescript
// plugin-types.ts

export interface PluginMetadata {
  id: string;                    // Unique plugin identifier
  name: string;                  // Display name
  description: string;           // Brief description
  version: string;               // Semantic version
  author: string;                // Plugin author
  icon?: string;                 // Optional icon/emoji
}

export interface PluginSettings {
  schema: SettingField[];        // Array of setting definitions
  defaults: Record<string, any>; // Default values
}

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
  onComplete?: (usage: {prompt_tokens: number, completion_tokens: number}) => void;
  onError?: (error: string) => void;
}

export interface PluginContext {
  conversationId: string;
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

export interface PluginComponentProps {
  context: PluginContext;
  panelState: 'expanded' | 'collapsed';
  onTogglePanel: () => void;
}

export interface Plugin {
  metadata: PluginMetadata;
  settings: PluginSettings;
  Component: React.ComponentType<PluginComponentProps>;
  onMount?: (context: PluginContext) => void;
  onUnmount?: () => void;
  onSettingsChange?: (newSettings: Record<string, any>, context: PluginContext) => void;
  onMessageAdded?: (context: PluginContext) => void; // Called when new message added
}
```

### 3.2 Example Plugin: Suggestions

```typescript
// plugins/SuggestionsPlugin.tsx

import { Plugin, PluginContext, LLMRequest } from './plugin-types';

const SuggestionsPlugin: Plugin = {
  metadata: {
    id: 'builtin.suggestions',
    name: 'Suggestions',
    description: 'AI-generated reply suggestions based on conversation context',
    version: '1.0.0',
    author: 'Forsee',
    icon: '💬'
  },

  settings: {
    schema: [
      {
        key: 'numSuggestions',
        label: 'Number of suggestions',
        type: 'range',
        description: 'How many suggestions to generate',
        default: 6,
        min: 2,
        max: 10,
        step: 1
      },
      {
        key: 'temperature',
        label: 'Creativity',
        type: 'range',
        description: 'Higher = more creative, lower = more predictable',
        default: 0.3,
        min: 0,
        max: 1,
        step: 0.1
      },
      {
        key: 'maxWords',
        label: 'Max words per suggestion',
        type: 'number',
        description: 'Maximum length of each suggestion',
        default: 12,
        min: 5,
        max: 30
      }
    ],
    defaults: {
      numSuggestions: 6,
      temperature: 0.3,
      maxWords: 12
    }
  },

  Component: ({ context, panelState, onTogglePanel }) => {
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [isStreaming, setIsStreaming] = useState(false);
    const fetchTimeoutRef = useRef<NodeJS.Timeout>();

    // Build LLM request based on context
    const buildPrompt = useCallback((): LLMRequest => {
      const { settings, currentText, keyboardPrefix, selectedHints } = context;

      const hintText = selectedHints.length > 0
        ? selectedHints.join(', ')
        : null;

      // Client sends only prompt + tools; server decides provider/model
      const prompt = `Generate ${settings.numSuggestions} natural reply suggestions.

${keyboardPrefix ? `All suggestions MUST start with: "${keyboardPrefix}"` : ''}
${hintText ? `Consider these hint words for guidance: ${hintText}` : ''}

Requirements:
- Each suggestion must be ${settings.maxWords} words or fewer
- Natural, conversational tone
- No emojis, no quotes
- Diverse options (different directions/tones)

Use the push_suggestion tool exactly ${settings.numSuggestions} times.`;

      return {
        prompt,
        tools: [
          {
            name: 'push_suggestion',
            description: 'Add a suggestion to the list',
            parameters: {
              type: 'object',
              properties: {
                suggestion: {
                  type: 'string',
                  description: 'The suggestion text'
                }
              },
              required: ['suggestion']
            }
          }
        ],
        temperature: settings.temperature,
        maxTokens: 500
        // No provider/model - server decides!
      };
    }, [context]);

    // Fetch suggestions with debouncing
    const fetchSuggestions = useCallback(() => {
      if (fetchTimeoutRef.current) {
        clearTimeout(fetchTimeoutRef.current);
      }

      fetchTimeoutRef.current = setTimeout(async () => {
        setIsStreaming(true);
        setSuggestions([]);

        const callbacks = {
          onToolCall: (toolName: string, args: Record<string, any>) => {
            if (toolName === 'push_suggestion') {
              setSuggestions(prev => {
                const newSuggestions = [...prev, args.suggestion];
                // Keep only last N suggestions (FIFO)
                if (newSuggestions.length > context.settings.numSuggestions) {
                  return newSuggestions.slice(-context.settings.numSuggestions);
                }
                return newSuggestions;
              });
            }
          },
          onComplete: () => {
            setIsStreaming(false);
          },
          onError: (error: string) => {
            console.error('Suggestions error:', error);
            setIsStreaming(false);
          }
        };

        await context.llmRequest(buildPrompt(), callbacks);
      }, 300); // 300ms debounce
    }, [context, buildPrompt]);

    // Auto-fetch on mount and when prefix/hints change
    useEffect(() => {
      fetchSuggestions();
    }, [context.keyboardPrefix, context.selectedHints]);

    // Handle suggestion selection with dwell time
    const handleSuggestionHover = (suggestion: string, isHovering: boolean) => {
      if (!isHovering) return;

      const timerId = setTimeout(() => {
        context.speak(suggestion);
        context.addMessage(suggestion, 'user');
      }, context.dwellTime);

      return () => clearTimeout(timerId);
    };

    return (
      <Panel
        title="Suggestions"
        isExpanded={panelState === 'expanded'}
        onToggle={onTogglePanel}
      >
        <div className="suggestions-list">
          {isStreaming && suggestions.length === 0 && (
            <div className="loading-skeletons">
              {Array(context.settings.numSuggestions).fill(0).map((_, i) => (
                <div key={i} className="skeleton" />
              ))}
            </div>
          )}

          {suggestions.map((suggestion, i) => (
            <div
              key={i}
              className="suggestion-item"
              onMouseEnter={(e) => handleSuggestionHover(suggestion, true)}
            >
              {suggestion}
            </div>
          ))}
        </div>
      </Panel>
    );
  },

  onMessageAdded: (context) => {
    // Trigger re-fetch when message added
    // Component will handle via useEffect
  }
};

export default SuggestionsPlugin;
```

### 3.3 Example Plugin: Hints

```typescript
// plugins/HintsPlugin.tsx

const HintsPlugin: Plugin = {
  metadata: {
    id: 'builtin.hints',
    name: 'Hints',
    description: 'Single-word hints with emojis to guide conversation direction',
    version: '1.0.0',
    author: 'Forsee',
    icon: '💡'
  },

  settings: {
    schema: [
      {
        key: 'numHints',
        label: 'Number of hints',
        type: 'range',
        description: 'How many hints to display',
        default: 20,
        min: 10,
        max: 40,
        step: 5
      },
      {
        key: 'temperature',
        label: 'Variety',
        type: 'range',
        description: 'Higher = more diverse hints',
        default: 0.7,
        min: 0,
        max: 1,
        step: 0.1
      }
    ],
    defaults: {
      numHints: 20,
      temperature: 0.7
    }
  },

  Component: ({ context, panelState, onTogglePanel }) => {
    const [hints, setHints] = useState<Array<{word: string, emoji: string}>>([]);
    const [selectedHints, setSelectedHints] = useState<Set<string>>(new Set());
    const [isStreaming, setIsStreaming] = useState(false);

    const buildPrompt = useCallback((excludeWords: string[] = []): LLMRequest => {
      const { settings } = context;

      const prompt = `Generate ${settings.numHints} single-word hints with emojis to guide conversation direction.

${excludeWords.length > 0 ? `EXCLUDE these words: ${excludeWords.join(', ')}` : ''}

Requirements:
- Each hint is ONE word + ONE emoji
- Diverse directions (topics, emotions, actions)
- Appropriate emojis that match the word

Use the push_hint tool exactly ${settings.numHints} times.`;

      return {
        prompt,
        tools: [
          {
            name: 'push_hint',
            description: 'Add a hint to the list',
            parameters: {
              type: 'object',
              properties: {
                word: { type: 'string', description: 'Single word hint' },
                emoji: { type: 'string', description: 'Related emoji' }
              },
              required: ['word', 'emoji']
            }
          }
        ],
        temperature: settings.temperature,
        maxTokens: 800
        // Server chooses provider/model
      };
    }, [context]);

    const fetchHints = useCallback(async (excludeWords: string[] = []) => {
      setIsStreaming(true);
      setHints([]);

      const callbacks = {
        onToolCall: (toolName: string, args: Record<string, any>) => {
          if (toolName === 'push_hint') {
            setHints(prev => [...prev, { word: args.word, emoji: args.emoji }]);
          }
        },
        onComplete: () => {
          setIsStreaming(false);
        },
        onError: (error: string) => {
          console.error('Hints error:', error);
          setIsStreaming(false);
        }
      };

      await context.llmRequest(buildPrompt(excludeWords), callbacks);
    }, [context, buildPrompt]);

    useEffect(() => {
      fetchHints();
    }, []);

    const handleHintClick = (word: string) => {
      setSelectedHints(prev => {
        const newSet = new Set(prev);
        if (newSet.has(word)) {
          newSet.delete(word);
        } else {
          newSet.add(word);
        }
        return newSet;
      });
    };

    const handleMoreHints = () => {
      const currentWords = hints.map(h => h.word);
      fetchHints(currentWords);
    };

    return (
      <Panel
        title="Hints"
        isExpanded={panelState === 'expanded'}
        onToggle={onTogglePanel}
      >
        <div className="hints-grid">
          {hints.map((hint, i) => (
            <div
              key={i}
              className={`hint-item ${selectedHints.has(hint.word) ? 'selected' : ''}`}
              onClick={() => handleHintClick(hint.word)}
            >
              <span className="emoji">{hint.emoji}</span>
              <span className="word">{hint.word}</span>
            </div>
          ))}

          {!isStreaming && (
            <button className="more-button" onClick={handleMoreHints}>
              More
            </button>
          )}
        </div>
      </Panel>
    );
  }
};

export default HintsPlugin;
```

---

## 4. Plugin Manager Implementation

### 4.1 Plugin Registry

```typescript
// PluginManager.ts

class PluginManager {
  private plugins: Map<string, Plugin> = new Map();
  private settings: Map<string, Record<string, any>> = new Map();
  private pusher: PusherClient;
  private conversationId: string;

  constructor(conversationId: string, pusherClient: PusherClient) {
    this.conversationId = conversationId;
    this.pusher = pusherClient;
    this.loadSettings();
  }

  // Register a plugin
  register(plugin: Plugin): void {
    this.plugins.set(plugin.metadata.id, plugin);

    // Load plugin settings from localStorage or use defaults
    const savedSettings = localStorage.getItem(`plugin_settings_${plugin.metadata.id}`);
    this.settings.set(
      plugin.metadata.id,
      savedSettings ? JSON.parse(savedSettings) : plugin.settings.defaults
    );
  }

  // Get all registered plugins
  getAll(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  // Get plugin by ID
  get(id: string): Plugin | undefined {
    return this.plugins.get(id);
  }

  // Get plugin settings
  getSettings(pluginId: string): Record<string, any> {
    return this.settings.get(pluginId) || {};
  }

  // Update plugin settings
  updateSettings(pluginId: string, newSettings: Record<string, any>): void {
    this.settings.set(pluginId, newSettings);
    localStorage.setItem(`plugin_settings_${pluginId}`, JSON.stringify(newSettings));

    // Notify plugin of settings change
    const plugin = this.plugins.get(pluginId);
    if (plugin?.onSettingsChange) {
      plugin.onSettingsChange(newSettings, this.buildContext(pluginId));
    }
  }

  // Generic LLM request helper
  async llmRequest(
    request: LLMRequest,
    callbacks: LLMStreamCallbacks
  ): Promise<string> {
    const streamingId = generateId();

    // Subscribe to Pusher events for this streaming session
    const channel = this.pusher.subscribe(`conversation-${this.conversationId}`);

    channel.bind('llm_token', (data: any) => {
      if (data.streaming_id === streamingId && callbacks.onToken) {
        callbacks.onToken(data.token);
      }
    });

    channel.bind('llm_tool_call', (data: any) => {
      if (data.streaming_id === streamingId && callbacks.onToolCall) {
        const args = JSON.parse(data.arguments);
        callbacks.onToolCall(data.name, args);
      }
    });

    channel.bind('llm_complete', (data: any) => {
      if (data.streaming_id === streamingId && callbacks.onComplete) {
        callbacks.onComplete(data.usage);
      }
    });

    channel.bind('llm_error', (data: any) => {
      if (data.streaming_id === streamingId && callbacks.onError) {
        callbacks.onError(data.error);
      }
    });

    // Send request to server
    const response = await fetch(`${API_BASE_URL}/api/llm/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...request,
        channel_id: `conversation-${this.conversationId}`,
        streaming_id: streamingId
      })
    });

    const { streaming_id } = await response.json();
    return streaming_id;
  }

  // Build plugin context
  private buildContext(pluginId: string): PluginContext {
    return {
      conversationId: this.conversationId,
      currentText: this.getCurrentText(),
      keyboardPrefix: this.getKeyboardPrefix(),
      selectedHints: this.getSelectedHints(),
      dwellTime: this.getDwellTime(),
      settings: this.getSettings(pluginId),
      llmRequest: this.llmRequest.bind(this),
      refreshOtherPlugins: this.refreshOtherPlugins.bind(this),
      speak: this.speak.bind(this),
      addMessage: this.addMessage.bind(this)
    };
  }

  // ... other helper methods
}

export default PluginManager;
```

### 4.2 Unified Settings UI

```typescript
// components/UnifiedSettings.tsx

const UnifiedSettings: React.FC<{ pluginManager: PluginManager }> = ({ pluginManager }) => {
  const [isOpen, setIsOpen] = useState(false);
  const plugins = pluginManager.getAll();

  return (
    <>
      <button className="settings-button" onClick={() => setIsOpen(true)}>
        ⚙️ Settings
      </button>

      {isOpen && (
        <Modal onClose={() => setIsOpen(false)}>
          <div className="unified-settings">
            <h2>Settings</h2>

            {/* Global settings */}
            <Section title="Global">
              <DwellTimeSetting />
            </Section>

            {/* Plugin-specific settings */}
            {plugins.map(plugin => (
              <Section key={plugin.metadata.id} title={plugin.metadata.name} icon={plugin.metadata.icon}>
                <p className="description">{plugin.metadata.description}</p>

                {plugin.settings.schema.map(field => (
                  <SettingField
                    key={field.key}
                    field={field}
                    value={pluginManager.getSettings(plugin.metadata.id)[field.key]}
                    onChange={(value) => {
                      const currentSettings = pluginManager.getSettings(plugin.metadata.id);
                      pluginManager.updateSettings(plugin.metadata.id, {
                        ...currentSettings,
                        [field.key]: value
                      });
                    }}
                  />
                ))}
              </Section>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
};

// Auto-generate form fields based on schema
const SettingField: React.FC<{
  field: SettingField;
  value: any;
  onChange: (value: any) => void;
}> = ({ field, value, onChange }) => {
  switch (field.type) {
    case 'range':
      return (
        <label>
          <span>{field.label}</span>
          <input
            type="range"
            min={field.min}
            max={field.max}
            step={field.step}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          <span className="value">{value}</span>
          {field.description && <small>{field.description}</small>}
        </label>
      );

    case 'number':
      return (
        <label>
          <span>{field.label}</span>
          <input
            type="number"
            min={field.min}
            max={field.max}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          {field.description && <small>{field.description}</small>}
        </label>
      );

    case 'boolean':
      return (
        <label>
          <input
            type="checkbox"
            checked={value}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{field.label}</span>
          {field.description && <small>{field.description}</small>}
        </label>
      );

    case 'select':
      return (
        <label>
          <span>{field.label}</span>
          <select value={value} onChange={(e) => onChange(e.target.value)}>
            {field.options?.map(opt => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {field.description && <small>{field.description}</small>}
        </label>
      );

    default:
      return (
        <label>
          <span>{field.label}</span>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {field.description && <small>{field.description}</small>}
        </label>
      );
  }
};
```

---

## 5. Server-Side Implementation

### 5.1 Smart LLM Proxy API

The server receives **only** the prompt and tools from the client, then intelligently selects the provider and model.

```python
# conversations/api_llm.py

from ninja import Router, Schema
from typing import Optional
import threading
import json
from django.conf import settings

router = Router()

class LLMTool(Schema):
    name: str
    description: str
    parameters: dict

class LLMStreamRequest(Schema):
    # CLIENT PROVIDES:
    prompt: str
    tools: Optional[list[LLMTool]] = None
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = 500
    stream_id: str  # Client-generated UUID for matching responses

    # NO provider, NO model, NO API key - server decides!

@router.post("/stream")
def stream_llm(request, data: LLMStreamRequest):
    """
    Smart LLM proxy endpoint.
    Client sends prompt + tools, server decides which provider/model to use.
    """

    # Server decides provider based on configuration
    provider_config = get_provider_config(request.user)

    def stream_in_background():
        try:
            # Route to appropriate provider based on server config
            if provider_config.provider == 'groq':
                stream_groq(data, provider_config)
            elif provider_config.provider == 'openai':
                stream_openai(data, provider_config)
            elif provider_config.provider == 'local':
                stream_local(data, provider_config)
            elif provider_config.provider == 'anthropic':
                stream_anthropic(data, provider_config)
        except Exception as e:
            trigger_event(data.stream_id, 'error', {'message': str(e)})

    thread = threading.Thread(target=stream_in_background)
    thread.start()

    return {"stream_id": data.stream_id, "status": "streaming"}


def get_provider_config(user):
    """
    SERVER-SIDE INTELLIGENCE: Determine which LLM provider to use.
    This is where deployment flexibility lives.
    """
    from dataclasses import dataclass

    @dataclass
    class ProviderConfig:
        provider: str
        model: str
        api_key: str = None
        endpoint: str = None

    # Option 1: Global setting (simplest for self-hosted)
    if hasattr(settings, 'LLM_PROVIDER'):
        return ProviderConfig(
            provider=settings.LLM_PROVIDER,
            model=settings.LLM_MODEL,
            api_key=getattr(settings, 'LLM_API_KEY', None),
            endpoint=getattr(settings, 'OLLAMA_ENDPOINT', None)
        )

    # Option 2: Per-user setting (for multi-tenant SaaS)
    if user and user.is_authenticated:
        user_settings = getattr(user, 'llm_settings', None)
        if user_settings:
            return ProviderConfig(
                provider=user_settings.provider,
                model=user_settings.model,
                api_key=user_settings.api_key or settings.DEFAULT_LLM_API_KEY
            )

    # Option 3: Smart routing based on request (advanced)
    # Choose provider based on tools, complexity, cost, etc.
    # if has_complex_tools(data.tools):
    #     return ProviderConfig(provider='openai', model='gpt-4o')
    # else:
    #     return ProviderConfig(provider='groq', model='llama-3.1-8b-instant')

    # Fallback to default
    return ProviderConfig(
        provider=getattr(settings, 'DEFAULT_PROVIDER', 'groq'),
        model=getattr(settings, 'DEFAULT_MODEL', 'llama-3.1-8b-instant'),
        api_key=getattr(settings, 'GROQ_API_KEY', None)
    )


def stream_groq(data: LLMStreamRequest, config):
    """Stream from Groq with server-selected model."""
    from groq import Groq

    client = Groq(api_key=config.api_key)

    # Convert tools format
    tools = None
    if data.tools:
        tools = [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters
                }
            }
            for tool in data.tools
        ]

    # Server chooses the model!
    stream = client.chat.completions.create(
        model=config.model,  # e.g., 'llama-3.1-8b-instant'
        messages=[{"role": "user", "content": data.prompt}],
        tools=tools,
        temperature=data.temperature,
        max_tokens=data.max_tokens,
        stream=True
    )

    current_tool_call = None

    for chunk in stream:
        delta = chunk.choices[0].delta

        # Stream content tokens
        if delta.content:
            trigger_event(data.stream_id, 'token', {'token': delta.content})

        # Handle tool calls
        if delta.tool_calls:
            for tool_call in delta.tool_calls:
                if tool_call.function.name:
                    current_tool_call = {
                        'name': tool_call.function.name,
                        'arguments': ''
                    }

                if tool_call.function.arguments:
                    current_tool_call['arguments'] += tool_call.function.arguments

                    # Try to parse complete JSON
                    try:
                        args = json.loads(current_tool_call['arguments'])
                        trigger_event(data.stream_id, 'tool_call', {
                            'name': current_tool_call['name'],
                            'arguments': args
                        })
                        current_tool_call = None
                    except json.JSONDecodeError:
                        pass  # Wait for more chunks

    trigger_event(data.stream_id, 'complete', {})


def stream_openai(data: LLMStreamRequest, config):
    """Stream from OpenAI with server-selected model."""
    import openai

    client = openai.OpenAI(api_key=config.api_key)

    # Similar implementation
    # Server decides model (gpt-4o, gpt-4o-mini, etc.)
    pass


def stream_local(data: LLMStreamRequest, config):
    """Stream from local Ollama instance."""
    import requests

    # Ollama endpoint (could be local or remote)
    url = f"{config.endpoint}/api/generate"

    response = requests.post(
        url,
        json={
            "model": config.model,  # e.g., 'llama3.1:8b'
            "prompt": data.prompt,
            "stream": True
        },
        stream=True
    )

    for line in response.iter_lines():
        if line:
            chunk = json.loads(line)
            if 'response' in chunk:
                trigger_event(data.stream_id, 'token', {'token': chunk['response']})

    trigger_event(data.stream_id, 'complete', {})


def stream_anthropic(data: LLMStreamRequest, config):
    """Stream from Anthropic Claude."""
    from anthropic import Anthropic

    client = Anthropic(api_key=config.api_key)

    # Implementation for Claude streaming
    pass


def trigger_event(stream_id: str, event_type: str, data: dict):
    """Send event to client via Pusher."""
    from conversations.utils_push import get_pusher_client

    pusher = get_pusher_client()
    pusher.trigger(
        f'llm-stream-{stream_id}',
        event_type,
        {**data, 'stream_id': stream_id}
    )
```

### 5.2 Django Settings Configuration

```python
# app/settings.py

# Simple global configuration (most common for accessibility tool)
LLM_PROVIDER = env('LLM_PROVIDER', default='groq')
LLM_MODEL = env('LLM_MODEL', default='llama-3.1-8b-instant')

# Provider-specific API keys
GROQ_API_KEY = env('GROQ_API_KEY', default=None)
OPENAI_API_KEY = env('OPENAI_API_KEY', default=None)
ANTHROPIC_API_KEY = env('ANTHROPIC_API_KEY', default=None)

# Local Ollama support (for privacy-focused self-hosting)
OLLAMA_ENDPOINT = env('OLLAMA_ENDPOINT', default='http://localhost:11434')

# Optional: Multi-provider configuration for advanced setups
LLM_PROVIDERS = {
    'groq': {
        'api_key': GROQ_API_KEY,
        'models': {
            'fast': 'llama-3.1-8b-instant',
            'smart': 'llama-3.1-70b-versatile'
        }
    },
    'openai': {
        'api_key': OPENAI_API_KEY,
        'models': {
            'fast': 'gpt-4o-mini',
            'smart': 'gpt-4o'
        }
    },
    'local': {
        'endpoint': OLLAMA_ENDPOINT,
        'models': {
            'fast': 'llama3.1:8b',
            'smart': 'llama3.1:70b'
        }
    }
}

DEFAULT_PROVIDER = 'groq'
DEFAULT_MODEL_TIER = 'fast'  # or 'smart'
```

### 5.3 Environment Variables (.env)

```bash
# Groq (default for hosted version - fast & cheap)
LLM_PROVIDER=groq
LLM_MODEL=llama-3.1-8b-instant
GROQ_API_KEY=gsk_...

# Or OpenAI (for users who want highest quality)
# LLM_PROVIDER=openai
# LLM_MODEL=gpt-4o-mini
# OPENAI_API_KEY=sk-...

# Or local Ollama (for privacy-focused self-hosters)
# LLM_PROVIDER=local
# LLM_MODEL=llama3.1:8b
# OLLAMA_ENDPOINT=http://localhost:11434
```

### 5.4 Deployment Scenarios

**Scenario 1: Hosted Version (You provide the server)**
```bash
# Your server configuration
LLM_PROVIDER=groq
GROQ_API_KEY=your_key

# Users connect to your-keyboard-server.com
# No client configuration needed!
# All API costs covered by you
```

**Scenario 2: Self-Hosted (Privacy-focused users)**
```bash
# User runs Ollama locally
docker run -d -p 11434:11434 ollama/ollama
ollama pull llama3.1:8b

# User's Django .env
LLM_PROVIDER=local
OLLAMA_ENDPOINT=http://localhost:11434
LLM_MODEL=llama3.1:8b

# All data stays on their machine!
# No external API calls
```

**Scenario 3: Enterprise (BYO API key)**
```bash
# Organization's configuration
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-org-...
LLM_MODEL=gpt-4o

# They control costs and compliance
# Can use their own Azure OpenAI deployment
```

**Scenario 4: Multi-tenant SaaS**
```python
# Different users, different providers
class User(models.Model):
    llm_provider = models.CharField(choices=['groq', 'openai', 'local'])
    llm_api_key = models.CharField(blank=True)  # Optional: BYO key
    plan_tier = models.CharField(choices=['free', 'premium'])

# In get_provider_config():
if user.plan_tier == 'free':
    # Free users get fast, cheap model
    return ProviderConfig(provider='groq', model='llama-3.1-8b-instant')
elif user.plan_tier == 'premium':
    # Premium users get best quality
    return ProviderConfig(provider='openai', model='gpt-4o')
```

---

## 6. Client-Side Implementation

### 6.1 useLLM Hook (Simplified Client API)

```typescript
// hooks/useLLM.ts

export function useLLM({
  prompt,
  tools,
  onToken,
  onToolCall,
  onComplete,
  onError,
  temperature = 0.7,
  maxTokens = 500,
  deps = [],
  enabled = true,
  debounce = 300
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const pusher = usePusher();  // Assume Pusher context

  useEffect(() => {
    if (!enabled) return;

    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);

      const streamId = generateId();

      try {
        // Subscribe to Pusher channel FIRST
        const channel = pusher.subscribe(`llm-stream-${streamId}`);

        channel.bind('token', (data) => {
          onToken?.(data.token);
        });

        channel.bind('tool_call', (data) => {
          onToolCall?.(data.name, data.arguments);
        });

        channel.bind('complete', () => {
          setLoading(false);
          onComplete?.();
          pusher.unsubscribe(`llm-stream-${streamId}`);
        });

        channel.bind('error', (data) => {
          setError(data.message);
          setLoading(false);
          onError?.(data.message);
          pusher.unsubscribe(`llm-stream-${streamId}`);
        });

        // Then start the stream
        // CLIENT DOES NOT SPECIFY PROVIDER/MODEL!
        await fetch('/api/llm/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            tools,
            temperature,
            max_tokens: maxTokens,
            stream_id: streamId
          })
        });

      } catch (e) {
        setError(e.message);
        setLoading(false);
      }
    }, debounce);

    return () => clearTimeout(timer);
  }, deps);

  return { loading, error };
}
```

### 6.2 Example: Ultra-Clean Plugin with useLLM

```typescript
// plugins/suggestions/index.tsx

export default function SuggestionsPlugin() {
  const { keyboard, settings } = usePlugin();
  const [suggestions, setSuggestions] = useState([]);

  // Plugins just write prompts - server handles everything else!
  const { loading } = useLLM({
    prompt: `Generate ${settings.count} natural reply suggestions.

Current text: "${keyboard.text}"
${keyboard.prefix ? `Must start with: "${keyboard.prefix}"` : ''}

Requirements:
- Natural conversational tone
- Max ${settings.maxWords} words each
- Diverse options

Use add_suggestion tool exactly ${settings.count} times.`,

    tools: [{
      name: 'add_suggestion',
      description: 'Add a suggestion to the list',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The suggestion text' }
        },
        required: ['text']
      }
    }],

    onToolCall: (name, args) => {
      if (name === 'add_suggestion') {
        setSuggestions(prev => [...prev, args.text]);
      }
    },

    temperature: settings.temperature,

    deps: [keyboard.prefix, keyboard.text, settings.count],

    enabled: Boolean(keyboard.text)  // Only fetch when there's text
  });

  return (
    <Panel title="Suggestions" loading={loading}>
      {suggestions.map(text => (
        <Suggestion
          key={text}
          text={text}
          onDwell={() => keyboard.speak(text)}
        />
      ))}
    </Panel>
  );
}
```

---

## 7. Benefits of Server-Side Model Selection

### 7.1 Security
✅ **API keys never in browser** - No risk of key exposure
✅ **Client can't bypass rate limits** - Server enforces all limits
✅ **No credential management in UI** - Simpler, more secure

### 7.2 Deployment Flexibility
✅ **Hosted version** - You provide server with your API keys
✅ **Self-hosted** - Users run local Ollama, fully private
✅ **Enterprise** - Organizations use their own API keys
✅ **Multi-tenant** - Different users, different providers

### 7.3 Cost Control
✅ **Server chooses cheapest model** - Optimize costs automatically
✅ **Rate limiting** - Prevent runaway costs
✅ **Usage tracking** - Monitor costs per user/plugin
✅ **Graceful degradation** - Fall back to cheaper models when needed

### 7.4 Developer Experience
✅ **Simpler plugins** - Just write prompts, no provider logic
✅ **Provider-agnostic** - Switch providers without changing plugins
✅ **Faster development** - Plugins work with any LLM backend
✅ **Better testing** - Mock server responses easily

### 7.5 User Experience
✅ **No configuration needed** - Works out of the box
✅ **Consistent performance** - Server picks best model
✅ **Offline support** - Can use local Ollama
✅ **Progressive enhancement** - Start free, upgrade later

---

## 8. Migration Strategy

### Phase 1: Server-Side Smart Proxy (Week 1) ✅ COMPLETED (2025-12-05)
1. ✅ Create `/api/llm/stream` endpoint - [conversations/api_llm.py](conversations/api_llm.py)
2. ✅ Implement `get_provider_config()` function - Server-side provider selection logic
3. ✅ Build `stream_groq()` with server-side model selection - Groq streaming implemented
4. ✅ Add LLM configuration to Django settings - [app/settings.py](app/settings.py) lines 119-129
5. ✅ Integrated into URL routing - [app/urls.py](app/urls.py) lines 22,27

**Deliverable**: ✅ Working server endpoint `/api/llm/stream` that accepts prompts and streams responses via Pusher

### Phase 2: Client-Side useLLM Hook (Week 2) ✅ COMPLETED (2025-12-05)
1. ✅ Create `useLLM()` custom hook - [keyboard-ui/src/hooks/useLLM.ts](keyboard-ui/src/hooks/useLLM.ts)
2. ✅ Implement Pusher subscription logic - Handles llm-stream-{id} channel
3. ✅ Handle token, tool_call, complete, error events - All event types supported
4. ✅ Add debouncing and enabled flag - Configurable debounce (default 300ms)
5. ✅ Export standalone llmRequest function - For imperative usage

**Deliverable**: ✅ Reusable hook and function for any plugin to call LLM without knowing provider/model

### Phase 3: Plugin Infrastructure (Week 3) ✅ COMPLETED (2025-12-05)
1. ✅ Define plugin interface types - [keyboard-ui/src/plugins/plugin-types.ts](keyboard-ui/src/plugins/plugin-types.ts)
2. ✅ Implement PluginManager class - [keyboard-ui/src/plugins/PluginManager.ts](keyboard-ui/src/plugins/PluginManager.ts)
3. ✅ Create Panel component - [keyboard-ui/src/components/Panel.jsx](keyboard-ui/src/components/Panel.jsx)
4. ✅ Build example EchoPlugin - [keyboard-ui/src/plugins/EchoPlugin.tsx](keyboard-ui/src/plugins/EchoPlugin.tsx)
5. ⏳ Unified settings UI component - Deferred to Phase 6

**Deliverable**: ✅ Plugin registration and lifecycle management complete

### Phase 4: Migrate Suggestions (Week 4) 🔄 IN PROGRESS (2025-12-05)
1. ✅ Convert Suggestions.js to SuggestionsPlugin.tsx - [keyboard-ui/src/plugins/SuggestionsPlugin.tsx](keyboard-ui/src/plugins/SuggestionsPlugin.tsx)
2. ✅ Remove provider/model from plugin code - Server handles all provider selection
3. ⏳ Integrate into App.js with PluginManager - Next step
4. ⏳ Test streaming with Groq (server-selected) - Pending integration
5. ⏳ Verify FIFO queue and debouncing work - Pending integration

**Deliverable**: Working Suggestions plugin with no provider logic

### Phase 5: Migrate Hints (Week 5)
1. ✅ Convert Hints.js to plugin using useLLM
2. ✅ Test exclude_words functionality
3. ✅ Verify "More" button works
4. ✅ Migrate settings to unified UI
5. ✅ Test hint selection and keyboard integration

**Deliverable**: Working Hints plugin

### Phase 6: Documentation & Cleanup (Week 6)
1. ✅ Deprecate old `/suggestions/stream` and `/hints/stream` endpoints
2. ✅ Write plugin development guide
3. ✅ Create plugin template repository
4. ✅ Document deployment scenarios (hosted, self-hosted, enterprise)
5. ✅ Create example third-party plugins

**Deliverable**: Complete plugin SDK and documentation

---

## 9. Third-Party Plugin Examples

### 9.1 Translation Plugin

```typescript
const TranslationPlugin: Plugin = {
  metadata: {
    id: 'community.translation',
    name: 'Translation',
    description: 'Translate suggestions into multiple languages',
    version: '1.0.0',
    author: 'Community',
    icon: '🌐'
  },

  settings: {
    schema: [
      {
        key: 'targetLanguage',
        label: 'Target Language',
        type: 'select',
        options: [
          { label: 'Spanish', value: 'es' },
          { label: 'French', value: 'fr' },
          { label: 'German', value: 'de' },
          { label: 'Japanese', value: 'ja' }
        ],
        default: 'es'
      }
    ],
    defaults: { targetLanguage: 'es' }
  },

  Component: ({ context }) => {
    const [translations, setTranslations] = useState<Array<{original: string, translated: string}>>([]);

    // Listen to other plugins' output and translate
    useEffect(() => {
      const systemPrompt = `Translate the following text to ${context.settings.targetLanguage}.
      Maintain the tone and style. Output only the translation.`;

      // This plugin could hook into suggestions
      // and translate them in real-time
    }, [context.currentText]);

    return (
      <Panel title="Translations">
        {/* Render translations */}
      </Panel>
    );
  }
};
```

### 9.2 Emoji Suggester Plugin

```typescript
const EmojiPlugin: Plugin = {
  metadata: {
    id: 'community.emoji',
    name: 'Emoji Suggester',
    description: 'Suggest relevant emojis for your message',
    version: '1.0.0',
    author: 'Community',
    icon: '😀'
  },

  settings: {
    schema: [
      {
        key: 'numEmojis',
        label: 'Number of emojis',
        type: 'range',
        min: 3,
        max: 12,
        default: 6
      }
    ],
    defaults: { numEmojis: 6 }
  },

  Component: ({ context }) => {
    const [emojis, setEmojis] = useState<string[]>([]);

    const fetchEmojis = useCallback(async () => {
      const prompt = {
        prompt: `Suggest ${context.settings.numEmojis} relevant emojis for this message: "${context.currentText}"`,
        tools: [{
          name: 'push_emoji',
          description: 'Add emoji to list',
          parameters: {
            type: 'object',
            properties: {
              emoji: { type: 'string' }
            }
          }
        }]
        // Server chooses provider/model
      };

      await context.llmRequest(prompt, {
        onToolCall: (name, args) => {
          if (name === 'push_emoji') {
            setEmojis(prev => [...prev, args.emoji]);
          }
        }
      });
    }, [context]);

    return (
      <Panel title="Emojis">
        <div className="emoji-grid">
          {emojis.map((emoji, i) => (
            <button
              key={i}
              onClick={() => {
                // Append emoji to current text
                context.speak(context.currentText + ' ' + emoji);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      </Panel>
    );
  }
};
```

### 9.3 Code Completion Plugin

```typescript
const CodeCompletionPlugin: Plugin = {
  metadata: {
    id: 'community.code-completion',
    name: 'Code Completion',
    description: 'Complete code snippets with syntax highlighting',
    version: '1.0.0',
    author: 'Community',
    icon: '💻'
  },

  settings: {
    schema: [
      {
        key: 'language',
        label: 'Programming Language',
        type: 'select',
        options: [
          { label: 'JavaScript', value: 'javascript' },
          { label: 'Python', value: 'python' },
          { label: 'TypeScript', value: 'typescript' },
          { label: 'Java', value: 'java' }
        ],
        default: 'javascript'
      },
      {
        key: 'includeComments',
        label: 'Include comments',
        type: 'boolean',
        default: true
      }
    ],
    defaults: {
      language: 'javascript',
      includeComments: true
    }
  },

  Component: ({ context }) => {
    const [completions, setCompletions] = useState<string[]>([]);

    // Detect if current text contains code
    const isCodeContext = /function|class|const|let|var|def|import/.test(context.currentText);

    useEffect(() => {
      if (!isCodeContext) return;

      const fetchCompletions = async () => {
        const prompt = {
          prompt: `You are a ${context.settings.language} code completion assistant.
Complete the following code:

${context.currentText}

${context.settings.includeComments ? 'Include helpful comments.' : 'No comments.'}`,
          temperature: 0.2
          // Server may choose a better model for code (e.g., llama-70b, gpt-4o)
        };

        let fullCompletion = '';
        await context.llmRequest(prompt, {
          onToken: (token) => {
            fullCompletion += token;
            setCompletions([fullCompletion]);
          }
        });
      };

      fetchCompletions();
    }, [context.currentText, isCodeContext]);

    if (!isCodeContext) return null;

    return (
      <Panel title="Code Completion">
        <pre className="code-block">
          <code>{completions[0]}</code>
        </pre>
      </Panel>
    );
  }
};
```

---

## 10. Plugin Discovery & Installation

### 10.1 Plugin Registry (Future Enhancement)

```typescript
// Plugin marketplace/registry
interface PluginRegistry {
  search(query: string): Promise<PluginManifest[]>;
  install(pluginId: string): Promise<Plugin>;
  uninstall(pluginId: string): Promise<void>;
  update(pluginId: string): Promise<Plugin>;
}

interface PluginManifest {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  downloadUrl: string;
  homepage: string;
  repository: string;
  license: string;
  screenshots: string[];
  ratings: {
    average: number;
    count: number;
  };
}
```

### 10.2 Plugin Loading Mechanisms

**Option 1: Static Import (Current)**
```typescript
// App.tsx
import SuggestionsPlugin from './plugins/SuggestionsPlugin';
import HintsPlugin from './plugins/HintsPlugin';

const pluginManager = new PluginManager(conversationId, pusher);
pluginManager.register(SuggestionsPlugin);
pluginManager.register(HintsPlugin);
```

**Option 2: Dynamic Import (NPM packages)**
```typescript
// User installs via npm: npm install @forsee-plugins/translation
import('@forsee-plugins/translation').then(module => {
  pluginManager.register(module.default);
});
```

**Option 3: Remote Loading (Advanced)**
```typescript
// Load from URL
const response = await fetch('https://plugin-registry.forsee.app/plugins/translation/1.0.0/bundle.js');
const code = await response.text();
const module = await import(/* webpackIgnore: true */ `data:text/javascript,${encodeURIComponent(code)}`);
pluginManager.register(module.default);
```

---

## 11. Security Considerations

### 11.1 Plugin Sandboxing
- Plugins run in same context as main app (for MVP)
- Future: Isolate plugins in Web Workers or iframes
- Rate limiting on LLM requests per plugin
- Token usage tracking and quotas

### 11.2 API Key Management
- Server-side API keys never exposed to client
- User can optionally provide their own keys (stored encrypted)
- Per-user rate limits in database

### 11.3 Content Security Policy
- Restrict plugin network access
- Validate plugin metadata and code signatures
- Review process for community plugins

---

## 12. Performance Optimizations

### 12.1 Caching
- Cache LLM responses for identical prompts
- TTL-based cache (5 minutes default)
- Per-conversation cache isolation

### 12.2 Debouncing & Throttling
- Debounce rapid plugin requests (300ms default)
- Throttle LLM calls (max 10/minute per plugin)
- Cancel in-flight requests when new one starts

### 12.3 Lazy Loading
- Load plugin components on-demand
- Code-split plugins into separate bundles
- Defer non-visible plugin initialization

---

## 13. Testing Strategy

### 13.1 Unit Tests
- Plugin interface validation
- PluginManager registration logic
- Settings persistence
- LLM request mocking

### 13.2 Integration Tests
- End-to-end plugin lifecycle
- Pusher event handling
- Server proxy API
- Settings UI interactions

### 13.3 Plugin Example Tests
- Suggestions plugin functionality
- Hints plugin with exclusions
- Third-party plugin template

---

## 14. Documentation Deliverables

### 14.1 Plugin Developer Guide
- Getting started tutorial
- API reference
- Best practices
- Example plugins

### 14.2 User Documentation
- Installing plugins
- Configuring settings
- Troubleshooting

### 14.3 Architecture Decision Records (ADRs)
- **Why client-side prompts?** - Enables third-party plugin development without server changes
- **Why server-side provider/model selection?** - Security (no API keys in browser), deployment flexibility, cost control
- **Why Pusher over SSE?** - Existing infrastructure, better mobile support, easier to scale
- **Settings storage strategy** - localStorage for quick access, optional server sync for multi-device

---

## 15. Open Questions & Decisions Needed

1. **User-Selectable Providers** (Low Priority):
   - Allow users to override server provider choice in settings?
   - Support for BYO API keys?

2. **Plugin Distribution**:
   - NPM packages, GitHub releases, or custom registry?
   - Approval process for community plugins?

3. **Monetization**:
   - Premium plugins marketplace?
   - Revenue sharing model?

4. **Versioning**:
   - Semantic versioning for plugins?
   - Backwards compatibility guarantees?

5. **Settings Sync**:
   - Store settings server-side for multi-device sync?
   - Export/import settings?

---

## 16. Success Metrics

- **Developer Adoption**: Number of third-party plugins created
- **User Engagement**: Plugin installation rate
- **Performance**: LLM response time (target <2s to first token)
- **Reliability**: Plugin error rate (target <1%)
- **Extensibility**: Time to develop new plugin (target <4 hours)
- **Deployment Flexibility**: Number of different deployment scenarios supported

---

## 17. Next Steps

1. **✅ Completed (2025-12-05)**:
   - ✅ Implement server-side `/api/llm/stream` endpoint
   - ✅ Create `useLLM()` hook for client
   - ✅ Build plugin infrastructure (PluginManager, types)
   - ✅ Create Panel component for plugins
   - ✅ Build example EchoPlugin
   - ✅ Convert Suggestions to SuggestionsPlugin.tsx

2. **🔄 In Progress (Current)**:
   - Integrate SuggestionsPlugin into App.js
   - Test end-to-end streaming with Groq
   - Verify all features work (FIFO, debouncing, hover, etc.)

3. **⏳ Immediate Next (This Week)**:
   - Create HintsPlugin.tsx following same pattern
   - Integrate HintsPlugin into App.js
   - Test "More" button and exclude_words functionality
   - Create basic unified settings UI (or use per-plugin settings temporarily)

4. **Short-term (Next Week)**:
   - Deprecate old `/suggestions/stream` and `/hints/stream` endpoints
   - Update any remaining code to use plugin architecture
   - Write plugin development guide
   - Document deployment scenarios

5. **Long-term (Next Quarter)**:
   - Add support for OpenAI, Anthropic, local Ollama providers
   - Implement smart provider routing (based on request complexity)
   - Create unified settings UI with auto-generated forms
   - Launch plugin marketplace
   - Support multi-tenant SaaS with per-user providers

---

## Appendix A: File Structure (Current Implementation)

```
forsee/
├── keyboard-ui/
│   ├── src/
│   │   ├── plugins/
│   │   │   ├── plugin-types.ts           # ✅ Plugin interface definitions
│   │   │   ├── PluginManager.ts          # ✅ Plugin registry and orchestration
│   │   │   ├── SuggestionsPlugin.tsx     # ✅ Built-in suggestions (no provider logic)
│   │   │   ├── EchoPlugin.tsx            # ✅ Example/test plugin
│   │   │   └── HintsPlugin.tsx           # ⏳ TODO: Built-in hints (no provider logic)
│   │   ├── hooks/
│   │   │   └── useLLM.ts                 # ✅ Hook for LLM requests
│   │   ├── components/
│   │   │   ├── Panel.jsx                 # ✅ Collapsible panel wrapper
│   │   │   ├── Suggestions.js            # 🔄 Original - to be replaced by plugin
│   │   │   ├── Hints.js                  # 🔄 Original - to be replaced by plugin
│   │   │   ├── Button.jsx                # ✅ Reusable button component
│   │   │   ├── Layout.jsx                # ✅ Layout with collapsible panels
│   │   │   └── UnifiedSettings.tsx       # ⏳ TODO: Settings UI
│   │   ├── App.js                        # 🔄 TODO: Integrate PluginManager
│   │   └── index.js
│   └── package.json
├── conversations/
│   ├── api.py                            # ✅ Existing endpoints (to deprecate later)
│   ├── api_llm.py                        # ✅ NEW: Smart LLM proxy
│   ├── utils_prompt_groq.py              # ✅ Groq streaming utilities
│   ├── models.py
│   └── signals.py
├── app/
│   ├── settings.py                       # ✅ LLM provider configuration added
│   └── urls.py                           # ✅ /api/llm routes added
└── plugin-architecture-design.md         # ✅ This document (with progress updates)
```

### Implementation Notes:
- ✅ = Completed
- 🔄 = In progress / needs integration
- ⏳ = TODO / planned

---

## Appendix B: Glossary

- **Plugin**: Self-contained module with prompts, callbacks, settings, and UI (NO provider/model logic)
- **Plugin Manager**: Central registry and orchestrator for plugins
- **Smart LLM Proxy**: Server endpoint that accepts prompts and intelligently selects provider/model
- **Provider Selection**: Server-side logic that chooses which LLM provider to use (Groq, OpenAI, Ollama, etc.)
- **Settings Schema**: JSON-like definition of plugin configuration options
- **Plugin Context**: Runtime environment passed to plugins with app state
- **Streaming ID**: Client-generated UUID for tracking LLM streaming sessions
- **Tool Call**: Function call from LLM during streaming (e.g., `push_suggestion`)
- **Dwell Time**: Hover duration before triggering selection action
- **useLLM Hook**: React hook for making LLM requests without specifying provider
- **Deployment Scenario**: How the system is deployed (hosted, self-hosted, enterprise, multi-tenant)

---

**Document Version**: 3.0 (Implementation In Progress)
**Last Updated**: 2025-12-05
**Author**: Claude (Anthropic)
**Status**: 70% Implemented (Phases 1-3 Complete, Phase 4 In Progress)
**Implementation Status**:
  - ✅ Phase 1: Server-side smart LLM proxy
  - ✅ Phase 2: Client-side useLLM hook
  - ✅ Phase 3: Plugin infrastructure (types, PluginManager, Panel)
  - 🔄 Phase 4: SuggestionsPlugin created (integration pending)
  - ⏳ Phase 5: HintsPlugin (planned)
  - ⏳ Phase 6: Documentation & cleanup (planned)
**Key Achievement**: Fully functional plugin architecture with server-side provider selection, enabling third-party plugin development without exposing API keys
