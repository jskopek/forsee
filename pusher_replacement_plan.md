# Django-Native Realtime Plan (Replacing Pusher)

## Goals
- Remove dependence on the hosted Pusher service and rely on infrastructure that ships with (or alongside) our Django deployment.
- Keep the same realtime features (message_added notifications, streaming suggestions/hints, new LLM proxy streams) with comparable latency.
- Provide a foundation that works locally, on a single box, or scaled out with Redis – all while integrating cleanly with Django’s auth/session model.

## Current Usage Snapshot
- `conversations/signals.py` publishes `message_added` to `conversation-<id>` via the global Pusher client.
- `conversations/api.py` + `api_llm.py` stream hints/suggestions/LLM tokens to channels such as `conversation-<id>` or `llm-stream-<stream_id>`.
- Keyboard UI (and plugin runtime) opens multiple Pusher connections and listens for predefined event names.

## Proposed Replacement: Django Channels + Channel Layers
- Adopt [Django Channels](https://channels.readthedocs.io/) as the WebSocket/SSE layer. This is a first-party Django project and integrates with ASGI, the Django ORM, sessions, and authentication.
- Use a channel layer (Redis in production, in-memory for dev/tests) so background threads/tasks can push events to WebSocket consumers.
- Replace Pusher event names with structured group messages:
  - `conversation.<uuid>` group for message_added / suggestion / hint events.
  - `llm.<stream_id>` group for LLM proxy streaming (tokens, tool_calls, complete, error).
- Clients connect over `/ws/conversations/<uuid>/` and `/ws/llm/<stream_id>/`, authenticated via existing Django session/CSRFTokens (or signed query params for unauthenticated contexts).

## Implementation Phases

### Phase 1 — Channels Infrastructure
1. Add dependencies: `channels`, `daphne` (ASGI server), and `redis` (Python client) to `pyproject.toml`.
2. Update `settings.py`:
   - `INSTALLED_APPS += ['channels']`
   - `ASGI_APPLICATION = 'app.asgi.application'`
   - Configure `CHANNEL_LAYERS` with Redis (prod) + `InMemoryChannelLayer` fallback (dev/tests).
3. Create `app/asgi.py` using `ProtocolTypeRouter` + `URLRouter` for websocket routes, wrapped in `AuthMiddlewareStack` for session auth.
4. Wire deployment docs/scripts to run `daphne` (or `uvicorn`) instead of `gunicorn` so WebSockets work out of the box.

### Phase 2 — Conversation Consumer
1. Create `conversations/consumers.py` with a `ConversationConsumer`:
   - Authenticate user / verify conversation access on `connect`.
   - Join group `conversation.{conversation_id}`.
   - Relay JSON messages to client (`type`, `payload`).
2. Update `conversations/signals.notify_message_added` to send via channel layer:
   ```py
   async_to_sync(channel_layer.group_send)(
       f"conversation.{conversation_id}",
       {
           "type": "conversation.event",
           "event": "message_added",
           "payload": {...},
       },
   )
   ```
3. Update hints/suggestions streaming helpers to write into the same group instead of hitting Pusher.

### Phase 3 — LLM Stream Consumer
1. Add `LLMStreamConsumer` bound to `/ws/llm/<stream_id>/`.
2. When `/api/llm/stream` (or plugin actions) are invoked:
   - Generate `stream_id` on the client (already in place).
   - Server spawns background thread as before, but uses `channel_layer.group_send(f"llm.{stream_id}", {...})` for `token`, `tool_call`, etc.
3. Client subscribes via new WebSocket helper, reusing existing plugin runtime parsing logic.

### Phase 4 — Frontend Migration
1. Build a thin `RealtimeClient` wrapper for the keyboard UI that:
   - Accepts `conversationId` + optional auth token.
   - Opens native WebSocket connections and exposes `.subscribe(event, handler)` similar to current Pusher API.
2. Update `App.js`, `Suggestions.js`, `Hints.js`, and `useLLM.ts` (or plugin host) to use the new client. Keep event names identical so business logic barely changes.
3. Add exponential backoff + heartbeat/ping handling to match Pusher reliability.
4. Feature flag between Pusher and Channels during migration if needed (`REACT_APP_REALTIME_MODE=channels`).

### Phase 5 — Cleanup & Ops
1. Remove `pusher` dependency, env vars, and helpers (`conversations/signals.get_pusher_client`).
2. Update deployment instructions (ENV_SETUP, README) to describe running Redis + Daphne.
3. Add monitoring hooks: log connection counts, dropped connections, and send metrics for streaming duration similar to Pusher logs.

## Notes & Considerations
- **Auth**: `SessionMiddlewareStack` lets us reuse existing cookies. For kiosk/embedded clients without Django sessions, issue signed tokens (e.g., `django.core.signing.TimestampSigner`) that the consumer verifies on connect.
- **Scaling**: Channels with Redis supports multiple worker processes, so we can keep linear scalability similar to using Pusher.
- **Fallback**: Keep a minimal SSE endpoint (optional) for environments where WebSockets aren’t permitted.
- **Testing**: Add integration tests using `channels.testing.WebsocketCommunicator` to ensure events dispatch correctly.

With this plan we replace Pusher with a first-party, fully self-hosted stack while touching only the Django app and React client—no external dependencies required.
