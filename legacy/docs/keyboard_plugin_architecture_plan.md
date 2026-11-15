# Client-Side Plugin + Minimal LLM Proxy Plan

## Goals
- Keep *all* plugin intelligence (prompt composition, tool definitions, response handling, settings) in the keyboard client.
- Reduce the server to a generic LLM proxy that accepts arbitrary prompts + tool definitions and streams tool callbacks back to the client.
- Maintain a unified settings + plugin surface in the UI so third parties can extend the keyboard without touching backend code.
- Preserve existing real-time experience (Pusher) while making callback wiring completely plugin-defined.

## Current Behavior Snapshot
- **Server (Django)**
  - Dedicated `/suggestions` + `/hints` endpoints that assemble prompts server-side (`conversations/utils_prompt_groq.py`) and stream tool invocations with hard-coded handlers.
- **Keyboard UI (React)**
  - Panels (Suggestions/Hints) only control small request parameters (`hint`, `prefix`) and react to fixed Pusher events.
  - No shared plugin registry or settings surface beyond dwell time.

This tight coupling is what we are undoing: prompt/tool logic moves to plugins, and server endpoints collapse into a single LLM proxy.

## Target Architecture

### 1. Client Plugin Runtime
- Introduce a `PluginHostContext` in React that loads plugin manifests at startup:
  ```ts
  type PanelPluginManifest = {
    id: string;
    displayName: string;
    panels: PanelConfig[];          // where/how to render UI
    actions: Record<string, PluginAction>; // see below
    settings: SettingField[];       // unified settings drawer
  };
  ```
- Each `PluginAction` contains:
  - `buildRequest(context, settings, payload)`: returns `{model, messages, tools, temperature, max_tokens}`.
  - `callbacks`: event names for tool data (`data`), completion, and error.
  - `parseToolCall`: helper the UI uses to interpret incoming tool payloads.
- Suggestions, Hints, and future panels become regular plugins registering via this manifest. Third parties can package a manifest + React component bundle without backend changes.

### 2. Minimal Server API (LLM Proxy)
- Single endpoint: `POST /api/llm/stream`.
  ```json
  {
    "conversation_id": "...",           // Optional: enables auth, logging, and channel naming
    "request": {                         // Direct proxy payload
      "model": "groq/llama3",
      "messages": [ ... ],
      "tools": [ ... ],
      "stream": true,
      "temperature": 0.3,
      "max_tokens": 500
    },
    "callbacks": {
      "channel": "conversation-<id>",
      "data": "plugin::<id>::data",
      "complete": "plugin::<id>::complete",
      "error": "plugin::<id>::error"
    }
  }
  ```
- Server responsibilities:
  1. Authenticate/authorize the caller, confirm they can access `conversation_id`.
  2. Execute the provided request against Groq/OpenAI using stored API keys.
  3. Stream tool/function call payloads right back to the provided Pusher channel/event names.
  4. Emit completion/error events and basic telemetry (plugin id, latency, tokens, errors) for observability.
- No prompt knowledge or callback logic lives here—the server just forwards chunks.

### 3. Conversation Context Fetching
- Because prompts now live on the client, plugins must gather any required context via existing REST endpoints before building the LLM payload (e.g., fetch last N messages, contact metadata).
- Provide convenience hooks/helpers inside the plugin runtime (`useConversationContext(id, {turns: 10})`) so plugin authors have a clean API for fetching and caching conversation data.

### 4. Streaming + Callback Handling on the Client
- Plugin runtime exposes `useLLMStream(pluginId, actionId)`:
  ```ts
  const { items, invoke, status, error } = useLLMStream('suggestions', 'generate');
  ```
  - `invoke(payload)` builds the request via plugin hooks, posts to `/api/llm/stream`, and subscribes to the declared Pusher events.
  - Incoming tool payloads flow through the plugin’s `parseToolCall` to become UI-friendly objects (e.g., `{text}` for suggestions, `{word, emoji}` for hints).
- This removes all endpoint-specific logic from `Suggestions.js` and `Hints.js`; they simply render `items` and call `invoke` when needed.

### 5. Unified Settings Drawer
- Settings component queries the plugin host for every plugin’s `settings` schema and renders controls grouped by plugin.
- Values persist locally (and optionally sync server-side later) and are injected into `buildRequest` so prompts can read them.
- Provide a standard “Plugin Settings” button in the keyboard chrome; panels can trigger a deep-link into their section.

### 6. Security & Abuse Guardrails
- Server validates payload size, number of tools, and rate-limits per user/plugin to avoid runaway prompts.
- Only allow approved models + tool schemas (e.g., enforce `type: function` with JSON schema) to prevent arbitrary LLM usage beyond intended keyboard features.
- Log `plugin_id`, `action_id`, prompt hashes, and callback events for monitoring since backend no longer understands the semantics of each call.

## Implementation Phases
1. **Server LLM Proxy**
   - Add `/api/llm/stream` endpoint plus helper that streams arbitrary tool calls to Pusher using client-provided event names.
   - Keep legacy `/suggestions` + `/hints` routes temporarily for backward compatibility, but have them internally call the new proxy using existing prompt builders until the UI migrates.
2. **Client Plugin Host Skeleton**
   - Implement manifest format, runtime context, settings store, and `useLLMStream` hook.
   - Port Suggestions/Hints panels to be first-party plugins; verify they can recreate current behavior solely from client logic.
3. **Unified Settings Drawer**
   - Render plugin-provided controls in the Settings component and wire persistence to localStorage (with schema versioning).
4. **Cleanup & Docs**
   - Remove server-side prompt logic once all built-in panels rely on the proxy.
   - Document plugin manifest, helper hooks, and `/api/llm/stream` contract so external developers can extend the keyboard safely.

This approach centralizes all “smart” behavior in the keyboard, leaving the server as a thin, reusable LLM proxy. Plugins can fully define how to prompt, what functions to expose, and how to render or configure their results, enabling a true third-party ecosystem without backend coupling.
