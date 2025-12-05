# Keyboard UI Plugin Architecture Design

## Executive Summary

This document outlines a plugin architecture for the Forsee keyboard UI that enables third-party developers to create powerful, self-contained extensions. The design moves LLM prompting logic from the server to client-side plugins, establishing a generic server-side proxy for LLM requests while giving plugins full control over prompts, callbacks, settings, and UI rendering.

---

## 1. Core Design Principles

### 1.1 Plugin Self-Containment
Each plugin should be a complete, independent module containing:
- **Prompt definition**: System and user prompts for LLM requests
- **Response handlers**: Callbacks for processing streaming/completed responses
- **Settings schema**: Configuration options exposed to users
- **UI component**: React component for rendering plugin output
- **Metadata**: Name, description, version, author

### 1.2 Server as Generic Proxy
The server should:
- Accept generic LLM requests with custom prompts
- Stream responses back via Pusher/WebSocket
- NOT contain plugin-specific logic
- Support multiple LLM providers (Groq, OpenAI, Anthropic, etc.)
- Handle authentication and rate limiting

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
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Plugin Manager                            │ │
│  │  - Registers plugins                                   │ │
│  │  - Manages plugin lifecycle                            │ │
│  │  - Collects settings schemas                           │ │
│  │  - Provides LLM request helper                         │ │
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
│                    │   LLM       │                          │
│                    │  Request    │                          │
│                    │  Client     │                          │
│                    └──────┬──────┘                          │
└───────────────────────────┼─────────────────────────────────┘
                            │
                      HTTP + WebSocket
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                  Django Server                               │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │           Generic LLM Proxy API                        │ │
│  │                                                        │ │
│  │  POST /api/llm/stream                                  │ │
│  │  {                                                     │ │
│  │    provider: "groq" | "openai" | "anthropic",         │ │
│  │    model: "llama-3.1-8b-instant",                     │ │
│  │    system_prompt: "...",                              │ │
│  │    messages: [{role, content}],                       │ │
│  │    tools: [{name, description, parameters}],          │ │
│  │    temperature: 0.7,                                  │ │
│  │    max_tokens: 500,                                   │ │
│  │    channel_id: "conversation-123"                     │ │
│  │  }                                                     │ │
│  │                                                        │ │
│  │  Response: {streaming_id: "xyz"}                       │ │
│  │                                                        │ │
│  │  Events streamed to Pusher:                            │ │
│  │  - llm_token: {streaming_id, token, type}             │ │
│  │  - llm_tool_call: {streaming_id, name, arguments}     │ │
│  │  - llm_complete: {streaming_id, usage}                │ │
│  │  - llm_error: {streaming_id, error}                   │ │
│  └────────────────────────────────────────────────────────┘ │
│                           │                                  │
│                    ┌──────▼──────┐                          │
│                    │   LLM       │                          │
│                    │  Provider   │                          │
│                    │  Adapters   │                          │
│                    └──────┬──────┘                          │
│              ┌────────────┼────────────┐                    │
│         ┌────▼────┐  ┌────▼────┐  ┌────▼────┐             │
│         │  Groq   │  │ OpenAI  │  │Anthropic│             │
│         │ Adapter │  │ Adapter │  │ Adapter │             │
│         └─────────┘  └─────────┘  └─────────┘             │
└──────────────────────────────────────────────────────────────┘
```

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
  provider: 'groq' | 'openai' | 'anthropic';
  model: string;
  systemPrompt: string;
  messages: Array<{role: 'user' | 'assistant', content: string}>;
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, any>;
  }>;
  temperature?: number;
  maxTokens?: number;
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

      const systemPrompt = `You are a helpful assistant generating natural reply suggestions for a conversation.

The user needs ${settings.numSuggestions} short, natural-sounding reply suggestions.

${keyboardPrefix ? `All suggestions MUST start with: "${keyboardPrefix}"` : ''}
${hintText ? `Consider these hint words for guidance: ${hintText}` : ''}

Requirements:
- Each suggestion must be ${settings.maxWords} words or fewer
- Natural, conversational tone
- No emojis, no quotes
- Diverse options (different directions/tones)

Use the push_suggestion tool exactly ${settings.numSuggestions} times.`;

      return {
        provider: 'groq',
        model: 'llama-3.1-8b-instant',
        systemPrompt,
        messages: [
          { role: 'user', content: 'Generate suggestions now.' }
        ],
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

      const systemPrompt = `Generate ${settings.numHints} single-word hints with emojis to guide conversation direction.

${excludeWords.length > 0 ? `EXCLUDE these words: ${excludeWords.join(', ')}` : ''}

Requirements:
- Each hint is ONE word + ONE emoji
- Diverse directions (topics, emotions, actions)
- Appropriate emojis that match the word

Use the push_hint tool exactly ${settings.numHints} times.`;

      return {
        provider: 'groq',
        model: 'llama-3.1-8b-instant',
        systemPrompt,
        messages: [
          { role: 'user', content: 'Generate hints now.' }
        ],
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

### 5.1 Generic LLM Proxy API

```python
# conversations/api_llm_proxy.py

from ninja import Router, Schema
from typing import Literal, Optional
import threading
import json
from groq import Groq
import openai
from anthropic import Anthropic

router = Router()

class LLMMessage(Schema):
    role: Literal['user', 'assistant', 'system']
    content: str

class LLMTool(Schema):
    name: str
    description: str
    parameters: dict

class LLMStreamRequest(Schema):
    provider: Literal['groq', 'openai', 'anthropic']
    model: str
    system_prompt: str
    messages: list[LLMMessage]
    tools: Optional[list[LLMTool]] = None
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = 500
    channel_id: str
    streaming_id: str

@router.post("/stream")
def stream_llm_request(request, data: LLMStreamRequest):
    """
    Generic LLM streaming endpoint.
    Accepts a prompt and configuration, streams responses back via Pusher.
    """

    def stream_in_background():
        try:
            if data.provider == 'groq':
                stream_groq(data)
            elif data.provider == 'openai':
                stream_openai(data)
            elif data.provider == 'anthropic':
                stream_anthropic(data)
        except Exception as e:
            _trigger_event(data.channel_id, 'llm_error', {
                'streaming_id': data.streaming_id,
                'error': str(e)
            })

    thread = threading.Thread(target=stream_in_background)
    thread.start()

    return {"streaming_id": data.streaming_id, "status": "streaming"}


def stream_groq(data: LLMStreamRequest):
    """Stream from Groq API with tool calling support."""
    from groq import Groq

    client = Groq(api_key=settings.GROQ_API_KEY)

    messages = [
        {"role": "system", "content": data.system_prompt}
    ] + [
        {"role": msg.role, "content": msg.content}
        for msg in data.messages
    ]

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

    stream = client.chat.completions.create(
        model=data.model,
        messages=messages,
        tools=tools,
        temperature=data.temperature,
        max_tokens=data.max_tokens,
        stream=True
    )

    current_tool_call = None

    for chunk in stream:
        delta = chunk.choices[0].delta

        # Handle content tokens
        if delta.content:
            _trigger_event(data.channel_id, 'llm_token', {
                'streaming_id': data.streaming_id,
                'token': delta.content,
                'type': 'content'
            })

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
                        _trigger_event(data.channel_id, 'llm_tool_call', {
                            'streaming_id': data.streaming_id,
                            'name': current_tool_call['name'],
                            'arguments': json.dumps(args)
                        })
                        current_tool_call = None
                    except json.JSONDecodeError:
                        pass  # Wait for more chunks

    _trigger_event(data.channel_id, 'llm_complete', {
        'streaming_id': data.streaming_id,
        'usage': {
            'prompt_tokens': 0,  # TODO: Get from response
            'completion_tokens': 0
        }
    })


def stream_openai(data: LLMStreamRequest):
    """Stream from OpenAI API."""
    # Similar implementation for OpenAI
    pass


def stream_anthropic(data: LLMStreamRequest):
    """Stream from Anthropic API."""
    # Similar implementation for Claude
    pass


def _trigger_event(channel_id: str, event_name: str, data: dict):
    """Send event to Pusher channel."""
    from conversations.utils_push import get_pusher_client

    pusher = get_pusher_client()
    pusher.trigger(channel_id, event_name, data)
```

### 5.2 Provider Adapters (Optional Enhancement)

Create adapter classes for each LLM provider to normalize their APIs:

```python
# conversations/llm_adapters.py

from abc import ABC, abstractmethod
from typing import Generator, Dict, Any

class LLMAdapter(ABC):
    @abstractmethod
    def stream(self, request: LLMStreamRequest) -> Generator[Dict[str, Any], None, None]:
        """Yield normalized events: {type: 'token'|'tool_call'|'complete'|'error', data: {...}}"""
        pass

class GroqAdapter(LLMAdapter):
    def stream(self, request: LLMStreamRequest):
        # Implementation
        pass

class OpenAIAdapter(LLMAdapter):
    def stream(self, request: LLMStreamRequest):
        # Implementation
        pass

class AnthropicAdapter(LLMAdapter):
    def stream(self, request: LLMStreamRequest):
        # Implementation
        pass
```

---

## 6. Migration Strategy

### Phase 1: Build Foundation (Week 1-2)
1. ✅ Create plugin interface types (`plugin-types.ts`)
2. ✅ Implement PluginManager class
3. ✅ Build generic LLM proxy API endpoint
4. ✅ Create unified settings UI component
5. ✅ Test with simple "Hello World" plugin

### Phase 2: Migrate Suggestions (Week 3)
1. ✅ Convert Suggestions.js to SuggestionsPlugin.tsx
2. ✅ Move prompt logic from server to plugin
3. ✅ Test streaming and callbacks
4. ✅ Migrate settings to unified UI
5. ✅ Verify backwards compatibility

### Phase 3: Migrate Hints (Week 4)
1. ✅ Convert Hints.js to HintsPlugin.tsx
2. ✅ Move prompt logic from server to plugin
3. ✅ Test exclude_words functionality
4. ✅ Migrate settings to unified UI
5. ✅ Verify "More" button works

### Phase 4: Deprecate Old Endpoints (Week 5)
1. ✅ Mark old endpoints as deprecated
2. ✅ Update documentation
3. ✅ Remove old server-side prompt logic
4. ✅ Clean up unused code

### Phase 5: Documentation & SDK (Week 6)
1. ✅ Write plugin development guide
2. ✅ Create plugin template repository
3. ✅ Document plugin API
4. ✅ Create example third-party plugins

---

## 7. Third-Party Plugin Examples

### 7.1 Translation Plugin

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

### 7.2 Emoji Suggester Plugin

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
        provider: 'groq',
        model: 'llama-3.1-8b-instant',
        systemPrompt: `Suggest ${context.settings.numEmojis} relevant emojis for this message: "${context.currentText}"`,
        messages: [{ role: 'user', content: 'Suggest emojis now' }],
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

### 7.3 Code Completion Plugin

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
          provider: 'groq',
          model: 'llama-3.1-70b-versatile', // Use larger model for code
          systemPrompt: `You are a ${context.settings.language} code completion assistant.
          Complete the following code:

          ${context.currentText}

          ${context.settings.includeComments ? 'Include helpful comments.' : 'No comments.'}`,
          messages: [{ role: 'user', content: 'Complete the code' }],
          temperature: 0.2
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

## 8. Plugin Discovery & Installation

### 8.1 Plugin Registry (Future Enhancement)

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

### 8.2 Plugin Loading Mechanisms

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

## 9. Security Considerations

### 9.1 Plugin Sandboxing
- Plugins run in same context as main app (for MVP)
- Future: Isolate plugins in Web Workers or iframes
- Rate limiting on LLM requests per plugin
- Token usage tracking and quotas

### 9.2 API Key Management
- Server-side API keys never exposed to client
- User can optionally provide their own keys (stored encrypted)
- Per-user rate limits in database

### 9.3 Content Security Policy
- Restrict plugin network access
- Validate plugin metadata and code signatures
- Review process for community plugins

---

## 10. Performance Optimizations

### 10.1 Caching
- Cache LLM responses for identical prompts
- TTL-based cache (5 minutes default)
- Per-conversation cache isolation

### 10.2 Debouncing & Throttling
- Debounce rapid plugin requests (300ms default)
- Throttle LLM calls (max 10/minute per plugin)
- Cancel in-flight requests when new one starts

### 10.3 Lazy Loading
- Load plugin components on-demand
- Code-split plugins into separate bundles
- Defer non-visible plugin initialization

---

## 11. Testing Strategy

### 11.1 Unit Tests
- Plugin interface validation
- PluginManager registration logic
- Settings persistence
- LLM request mocking

### 11.2 Integration Tests
- End-to-end plugin lifecycle
- Pusher event handling
- Server proxy API
- Settings UI interactions

### 11.3 Plugin Example Tests
- Suggestions plugin functionality
- Hints plugin with exclusions
- Third-party plugin template

---

## 12. Documentation Deliverables

### 12.1 Plugin Developer Guide
- Getting started tutorial
- API reference
- Best practices
- Example plugins

### 12.2 User Documentation
- Installing plugins
- Configuring settings
- Troubleshooting

### 12.3 Architecture Decision Records (ADRs)
- Why client-side prompts?
- Why Pusher over SSE?
- Settings storage strategy

---

## 13. Open Questions & Decisions Needed

1. **LLM Provider Selection**:
   - Should users choose provider per-plugin or globally?
   - Support for local LLMs (Ollama, etc.)?

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

## 14. Success Metrics

- **Developer Adoption**: Number of third-party plugins created
- **User Engagement**: Plugin installation rate
- **Performance**: LLM response time (target <2s to first token)
- **Reliability**: Plugin error rate (target <1%)
- **Extensibility**: Time to develop new plugin (target <4 hours)

---

## 15. Next Steps

1. **Immediate**:
   - Review and approve this architecture
   - Set up TypeScript interfaces
   - Create PluginManager skeleton

2. **Short-term** (This Week):
   - Implement generic LLM proxy API
   - Build unified settings UI
   - Convert Suggestions to plugin

3. **Medium-term** (This Month):
   - Complete all built-in plugins
   - Write developer documentation
   - Create plugin template

4. **Long-term** (Next Quarter):
   - Launch plugin marketplace
   - Add plugin discovery UI
   - Support remote plugin loading

---

## Appendix A: File Structure

```
forsee/
├── keyboard-ui/
│   ├── src/
│   │   ├── plugins/
│   │   │   ├── plugin-types.ts           # Plugin interface definitions
│   │   │   ├── PluginManager.ts          # Plugin registry and orchestration
│   │   │   ├── SuggestionsPlugin.tsx     # Built-in suggestions
│   │   │   ├── HintsPlugin.tsx           # Built-in hints
│   │   │   └── KeyboardPlugin.tsx        # Built-in virtual keyboard
│   │   ├── components/
│   │   │   ├── UnifiedSettings.tsx       # Settings UI
│   │   │   ├── Panel.jsx                 # Collapsible panel wrapper
│   │   │   └── PluginContainer.tsx       # Plugin rendering wrapper
│   │   ├── App.tsx                       # Root with PluginManager
│   │   └── index.tsx
│   └── package.json
├── conversations/
│   ├── api.py                            # Existing endpoints (deprecated)
│   ├── api_llm_proxy.py                  # NEW: Generic LLM proxy
│   ├── llm_adapters.py                   # NEW: Provider adapters
│   ├── models.py
│   └── signals.py
└── docs/
    ├── plugin-development-guide.md       # Developer documentation
    └── architecture-decision-records/
        └── 001-plugin-architecture.md    # This document
```

---

## Appendix B: Glossary

- **Plugin**: Self-contained module with prompts, callbacks, settings, and UI
- **Plugin Manager**: Central registry and orchestrator for plugins
- **LLM Proxy**: Generic server endpoint for executing LLM requests
- **Settings Schema**: JSON-like definition of plugin configuration options
- **Plugin Context**: Runtime environment passed to plugins with app state
- **Streaming ID**: Unique identifier for tracking LLM streaming sessions
- **Tool Call**: Function call from LLM during streaming (e.g., `push_suggestion`)
- **Dwell Time**: Hover duration before triggering selection action

---

**Document Version**: 1.0
**Last Updated**: 2025-12-05
**Author**: Claude (Anthropic)
**Status**: Proposed
**Review Status**: Pending Approval
