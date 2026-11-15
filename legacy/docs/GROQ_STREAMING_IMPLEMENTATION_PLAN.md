# Groq Streaming Implementation Plan

## Overview

This plan outlines the implementation of real-time streaming suggestions and hints using Groq's API with tool calls and Pusher WebSocket updates. The goal is to achieve 10x faster time-to-first-suggestion compared to the current OpenAI implementation.

## Architecture Overview

**NO Celery/Channels needed!** We'll stream directly from Django view → Pusher → Frontend in real-time.

**FIFO Strategy**: Show suggestions/hints as they arrive, pushing out oldest items for a constantly updating, responsive UI.

## Key Design Decisions

✅ **Direct Pusher streaming** - Django view streams in thread, pushes via Pusher
✅ **Full streaming** - Maximum speed, suggestions appear instantly
✅ **Tool calls** - Clean, structured streaming
✅ **Groq only** - Remove all OpenAI code
✅ **FIFO UI** - Newest items push out oldest, always showing latest 6 suggestions / 20 hints

## Current vs New Performance

### Current (OpenAI Responses API)
- Time to first suggestion: 2-5 seconds
- Time to all 6 suggestions: 5-10 seconds
- User sees: Nothing, then suddenly 6 suggestions

### New (Groq streaming with tool calls + Pusher)
- Time to first suggestion: **200-500ms** ⚡
- Time to all 6 suggestions: **1-2 seconds** ⚡
- User sees: Suggestions appearing one-by-one as they're generated
- **Speed improvement**: ~10x faster time-to-first-suggestion, ~5x faster overall

## How It Works

Instead of asking Groq to return a JSON array, we give it a `push_suggestion` tool that it can call 6 times (once per suggestion). With streaming enabled, each tool call arrives as it's generated.

### Tool Call Flow

1. Frontend triggers `/api/conversations/{id}/suggestions/stream`
2. Django endpoint starts streaming from Groq in background thread
3. As Groq generates each suggestion, it calls `push_suggestion` tool
4. Backend parses tool call and immediately pushes to Pusher
5. Frontend receives Pusher event and adds suggestion to FIFO queue
6. User sees suggestion appear ~200-500ms after request

## Implementation Plan

### Phase 1: Backend - Direct Streaming (No Background Tasks)

#### 1.1 Replace OpenAI with Groq

**Create: `conversations/utils_prompt_groq.py`**

```python
import os
import json
import logging
from groq import Groq

logger = logging.getLogger(__name__)

_GROQ_CLIENT = None

def _get_groq_client():
    global _GROQ_CLIENT
    if _GROQ_CLIENT is None:
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError("GROQ_API_KEY not set")
        _GROQ_CLIENT = Groq(api_key=api_key)
    return _GROQ_CLIENT


def stream_suggestions_with_tools(conversation, hint=None, prefix=None):
    """
    Stream suggestions using Groq tool calls.
    Yields each suggestion as soon as the model generates it.
    """
    client = _get_groq_client()

    # Build compact prompt (same logic as current implementation)
    MAX_WORDS = 12
    N_SUGGESTIONS = 6
    HISTORY_TURNS = 10

    contact = conversation.contact
    contact_name = getattr(contact, "name", None) or ""
    contact_formality = getattr(contact, "formality", None) or "casual"

    # Get recent messages
    from .models import Message
    qs = conversation.messages.order_by("-created_at", "-id").values("sender", "body")[:HISTORY_TURNS]
    recent = list(reversed(list(qs)))

    def _role_line(sender: str, body: str) -> str:
        if sender == Message.Sender.CONTACT:
            return f"Contact: {body}".strip()
        else:
            return f"You: {body}".strip()

    transcript_lines = [_role_line(m["sender"], m["body"]) for m in recent if m.get("body")]
    transcript = "\n".join(transcript_lines)

    # System prompt optimized for tool calls
    system_prompt = (
        f"Generate {N_SUGGESTIONS} short reply suggestions by calling push_suggestion exactly {N_SUGGESTIONS} times.\n"
        f"Each suggestion: ≤{MAX_WORDS} words, natural speech, no emojis/quotes.\n"
        "If user_hint exists, prioritize it over conversation content.\n"
        "If user_prefix exists, EVERY suggestion MUST start with a complete English word matching that prefix.\n"
        f"Formality: {contact_formality}. Use contact_name sparingly.\n"
        "Call push_suggestion once per suggestion immediately as you think of it."
    )

    user_payload = {
        "formality": contact_formality,
        "contact_name": contact_name,
        "transcript": transcript,
    }
    if hint:
        user_payload["user_hint"] = hint.strip()[:160]
    if prefix:
        user_payload["user_prefix"] = prefix.strip()[:40]

    # Define tool
    tools = [{
        "type": "function",
        "function": {
            "name": "push_suggestion",
            "description": "Push a single suggestion to the user immediately",
            "parameters": {
                "type": "object",
                "properties": {
                    "suggestion": {
                        "type": "string",
                        "description": "A short, natural reply suggestion"
                    }
                },
                "required": ["suggestion"]
            }
        }
    }]

    # Stream with tool calls
    logger.info(f"Groq streaming suggestions for conversation {conversation.id}")
    stream = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)}
        ],
        tools=tools,
        stream=True,
        temperature=0.3,
        max_tokens=500
    )

    # Parse streaming tool calls
    tool_call_buffer = ""
    suggestion_count = 0

    for chunk in stream:
        delta = chunk.choices[0].delta

        if hasattr(delta, 'tool_calls') and delta.tool_calls:
            tool_call = delta.tool_calls[0]

            if hasattr(tool_call, 'function') and hasattr(tool_call.function, 'arguments'):
                tool_call_buffer += tool_call.function.arguments

                # Try to parse complete JSON
                try:
                    args = json.loads(tool_call_buffer)
                    if 'suggestion' in args:
                        suggestion = args['suggestion'].strip()
                        if suggestion:
                            logger.info(f"Suggestion {suggestion_count}: {suggestion}")
                            yield suggestion
                            suggestion_count += 1
                            tool_call_buffer = ""

                            if suggestion_count >= N_SUGGESTIONS:
                                return
                except json.JSONDecodeError:
                    # Not complete yet, keep buffering
                    continue

    logger.info(f"Streaming complete: {suggestion_count} suggestions generated")


def stream_hints_with_tools(conversation):
    """
    Stream hints using Groq tool calls.
    Yields each hint dict as soon as the model generates it.
    """
    client = _get_groq_client()

    N_HINTS = 20
    HISTORY_TURNS = 5

    contact = conversation.contact
    contact_name = getattr(contact, "name", None) or ""
    contact_formality = getattr(contact, "formality", None) or "casual"

    from .models import Message
    qs = conversation.messages.order_by("-created_at", "-id").values("sender", "body")[:HISTORY_TURNS]
    recent = list(reversed(list(qs)))

    def _role_line(sender: str, body: str) -> str:
        if sender == Message.Sender.CONTACT:
            return f"Contact: {body}".strip()
        else:
            return f"You: {body}".strip()

    transcript_lines = [_role_line(m["sender"], m["body"]) for m in recent if m.get("body")]
    transcript = "\n".join(transcript_lines)

    last_message = recent[-1] if recent else None
    last_message_text = last_message.get("body", "") if last_message else ""

    system_prompt = (
        f"Generate {N_HINTS} single-word hints by calling push_hint exactly {N_HINTS} times.\n"
        "Each hint: ONE word (no spaces/hyphens) + ONE emoji.\n"
        "Cover diverse response directions: emotions, actions, topics.\n"
        "Call push_hint immediately as you think of each hint."
    )

    user_payload = {
        "formality": contact_formality,
        "contact_name": contact_name,
        "transcript": transcript,
        "last_message": last_message_text,
    }

    tools = [{
        "type": "function",
        "function": {
            "name": "push_hint",
            "description": "Push a single word hint with emoji immediately",
            "parameters": {
                "type": "object",
                "properties": {
                    "word": {"type": "string", "description": "Single word, lowercase"},
                    "emoji": {"type": "string", "description": "Single emoji character"}
                },
                "required": ["word", "emoji"]
            }
        }
    }]

    logger.info(f"Groq streaming hints for conversation {conversation.id}")
    stream = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)}
        ],
        tools=tools,
        stream=True,
        temperature=0.7,
        max_tokens=800
    )

    tool_call_buffer = ""
    hint_count = 0
    seen_words = set()

    for chunk in stream:
        delta = chunk.choices[0].delta

        if hasattr(delta, 'tool_calls') and delta.tool_calls:
            tool_call = delta.tool_calls[0]

            if hasattr(tool_call, 'function') and hasattr(tool_call.function, 'arguments'):
                tool_call_buffer += tool_call.function.arguments

                try:
                    args = json.loads(tool_call_buffer)
                    if 'word' in args and 'emoji' in args:
                        word = args['word'].strip().lower()
                        emoji = args['emoji'].strip()

                        # Deduplicate
                        if word and emoji and word not in seen_words:
                            seen_words.add(word)
                            logger.info(f"Hint {hint_count}: {word} {emoji}")
                            yield {"word": word, "emoji": emoji}
                            hint_count += 1
                            tool_call_buffer = ""

                            if hint_count >= N_HINTS:
                                return
                except json.JSONDecodeError:
                    continue

    logger.info(f"Streaming complete: {hint_count} hints generated")
```

#### 1.2 Create Direct Streaming API Endpoints

**Update: `conversations/api.py`**

```python
import threading
import logging
from .utils_prompt_groq import stream_suggestions_with_tools, stream_hints_with_tools
from .signals import get_pusher_client

logger = logging.getLogger(__name__)

def _stream_to_pusher(generator_func, channel_name, event_name, *args):
    """
    Helper to stream from generator to Pusher in a thread.
    This returns immediately while streaming happens in background.
    """
    pusher_client = get_pusher_client()
    if not pusher_client:
        logger.error("No Pusher client available")
        return

    def _stream():
        try:
            index = 0
            for item in generator_func(*args):
                pusher_client.trigger(channel_name, event_name, {
                    'index': index,
                    'data': item,
                })
                index += 1

            # Signal complete
            pusher_client.trigger(channel_name, f"{event_name}_complete", {
                'count': index
            })
        except Exception as e:
            logger.error(f"Streaming error: {e}", exc_info=True)
            pusher_client.trigger(channel_name, f"{event_name}_error", {
                'error': str(e)
            })

    # Start thread and return immediately
    thread = threading.Thread(target=_stream, daemon=True)
    thread.start()


@api_router.post("/{conversation_id}/suggestions/stream")
def stream_suggestions(request, conversation_id: UUID, body: SuggestionsRequest):
    """
    Start streaming suggestions via Pusher.
    Returns immediately; suggestions arrive via WebSocket events.
    """
    if not request.user.is_authenticated:
        raise HttpError(401, "Authentication required")

    conversation = get_conversation_or_404(conversation_id, request.user)

    hint = body.hint.strip() if body.hint else None
    prefix = body.prefix.strip() if body.prefix else None

    channel_name = f'conversation-{conversation_id}'

    # Start streaming in background thread
    _stream_to_pusher(
        stream_suggestions_with_tools,
        channel_name,
        'suggestion_ready',
        conversation,
        hint,
        prefix
    )

    return {"status": "streaming"}


@api_router.post("/{conversation_id}/hints/stream")
def stream_hints(request, conversation_id: UUID):
    """Start streaming hints via Pusher"""
    if not request.user.is_authenticated:
        raise HttpError(401, "Authentication required")

    conversation = get_conversation_or_404(conversation_id, request.user)

    channel_name = f'conversation-{conversation_id}'

    _stream_to_pusher(
        stream_hints_with_tools,
        channel_name,
        'hint_ready',
        conversation
    )

    return {"status": "streaming"}
```

#### 1.3 Remove OpenAI Code

Delete or rename these files:
- `conversations/utils_prompt_openai.py` → Remove entirely
- Update `conversations/utils_generators.py` → Remove `generate_reply_suggestions` and `generate_word_hints` functions (replaced by streaming versions)

### Phase 2: Frontend - FIFO Streaming UI

#### 2.1 Update Suggestions with FIFO

**Update: `keyboard-ui/src/components/Suggestions.js`**

```javascript
import React, { useState, useEffect, useRef, useCallback } from 'react';
import Pusher from 'pusher-js';

const Suggestions = ({ prefix, hintText, dwellTime, conversationId, onSpeak, onShowToast, onRegisterRefresh, onLoadingChange, onTextChange }) => {
  const MAX_SUGGESTIONS = 6;

  // FIFO queue: newest suggestions push out oldest
  const [suggestions, setSuggestions] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const pusherRef = useRef(null);
  const containerHoverRef = useRef(false);
  const hoverTimerRef = useRef(null);

  // Initialize Pusher
  useEffect(() => {
    if (!conversationId) return;

    const pusher = new Pusher(process.env.REACT_APP_PUSHER_KEY, {
      cluster: process.env.REACT_APP_PUSHER_CLUSTER
    });

    const channel = pusher.subscribe(`conversation-${conversationId}`);

    channel.bind('suggestion_ready', (data) => {
      console.log(`[Suggestions] Received: ${data.data}`);

      setSuggestions(prev => {
        // FIFO: Add new to end, remove from start if > MAX
        const updated = [...prev, data.data];
        if (updated.length > MAX_SUGGESTIONS) {
          return updated.slice(-MAX_SUGGESTIONS); // Keep last 6
        }
        return updated;
      });
    });

    channel.bind('suggestion_ready_complete', () => {
      console.log('[Suggestions] Streaming complete');
      setIsStreaming(false);
      if (onLoadingChange) onLoadingChange(false);
    });

    channel.bind('suggestion_ready_error', (data) => {
      console.error('[Suggestions] Error:', data.error);
      setIsStreaming(false);
      if (onLoadingChange) onLoadingChange(false);
      if (onShowToast) onShowToast(`Error: ${data.error}`);
    });

    pusherRef.current = pusher;
    return () => {
      pusher.unsubscribe(`conversation-${conversationId}`);
      pusher.disconnect();
    };
  }, [conversationId, onLoadingChange, onShowToast]);

  const fetchSuggestions = useCallback(async () => {
    if (!conversationId || containerHoverRef.current) return;

    // Clear existing and start streaming
    setSuggestions([]);
    setIsStreaming(true);
    if (onLoadingChange) onLoadingChange(true);

    const apiBaseUrl = process.env.REACT_APP_API_BASE_URL ||
                       window.API_BASE_URL ||
                       (process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : '');

    try {
      const response = await fetch(
        `${apiBaseUrl}/api/conversations/${conversationId}/suggestions/stream`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hint: hintText?.trim() || null,
            prefix: prefix?.trim() || null
          })
        }
      );

      if (!response.ok) {
        throw new Error('Failed to start streaming');
      }

      console.log('[Suggestions] Streaming started');
    } catch (err) {
      console.error('[Suggestions] Error:', err);
      setIsStreaming(false);
      if (onLoadingChange) onLoadingChange(false);
      if (onShowToast) onShowToast('Failed to load suggestions');
    }
  }, [conversationId, prefix, hintText, onLoadingChange, onShowToast]);

  // Auto-fetch on mount and when prefix/hint changes
  useEffect(() => {
    if (!conversationId) return;

    const debounceTimer = setTimeout(() => {
      fetchSuggestions();
    }, 300);

    return () => clearTimeout(debounceTimer);
  }, [conversationId, prefix, hintText, fetchSuggestions]);

  // Register refresh callback
  useEffect(() => {
    if (onRegisterRefresh) {
      onRegisterRefresh(() => {
        if (!containerHoverRef.current) {
          fetchSuggestions();
        }
      });
    }
  }, [onRegisterRefresh, fetchSuggestions]);

  const applySuggestion = (suggestion) => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }
    onTextChange(suggestion);
    if (onSpeak) onSpeak(suggestion);
  };

  const handleSuggestionHover = (suggestion) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);

    hoverTimerRef.current = setTimeout(() => {
      applySuggestion(suggestion);
    }, dwellTime);
  };

  const handleSuggestionLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }
  };

  return (
    <div
      className="flex-[2] flex flex-col p-0 relative min-h-0"
      onMouseEnter={() => { containerHoverRef.current = true; }}
      onMouseLeave={() => { containerHoverRef.current = false; }}
    >
      {suggestions.length === 0 && !isStreaming && (
        <div className="flex-1 flex items-center justify-center bg-bg-main">
          <div className="text-white text-lg">No suggestions available</div>
        </div>
      )}

      {(suggestions.length > 0 || isStreaming) && (
        <div className="flex-1 grid grid-cols-1" style={{ gridTemplateRows: `repeat(${MAX_SUGGESTIONS}, 1fr)` }}>
          {/* Show suggestions as they arrive, with placeholders for empty slots */}
          {Array.from({ length: MAX_SUGGESTIONS }, (_, index) => {
            const suggestion = suggestions[index];

            return suggestion ? (
              <button
                key={`${suggestion}-${index}`}
                className="relative flex items-center justify-center w-full h-full border-none outline-none bg-transparent text-white text-xl cursor-pointer overflow-hidden before:content-[''] before:absolute before:inset-0 before:bg-key-back before:transition-colors before:duration-[120ms] before:z-[1] after:content-[''] after:absolute after:inset-1 after:bg-key-front after:border after:border-key-border after:rounded-lg after:transition-colors after:duration-[120ms] after:z-[1] hover:before:bg-key-back-hover hover:after:bg-key-front-hover hover:after:border-key-border-hover group"
                onMouseEnter={() => handleSuggestionHover(suggestion)}
                onMouseLeave={handleSuggestionLeave}
                onClick={() => applySuggestion(suggestion)}
              >
                <span className="absolute inset-1 rounded-lg bg-white/28 origin-left z-[2] pointer-events-none animate-dwell-fill" />
                <span className="relative z-[3] font-semibold text-center px-4 break-words">
                  {suggestion}
                </span>
              </button>
            ) : isStreaming ? (
              // Loading skeleton
              <div key={`skeleton-${index}`} className="relative flex items-center justify-center w-full h-full bg-key-front/30 border border-key-border/30 rounded-lg mx-1 my-0.5 animate-pulse">
                <div className="h-4 bg-gray-500/30 rounded w-3/4"></div>
              </div>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
};

export default Suggestions;
```

#### 2.2 Update Hints with FIFO

**Update: `keyboard-ui/src/components/Hints.js`**

```javascript
// Similar pattern, but with 20 hints in FIFO queue
const Hints = ({ selectedHints, onHintToggle, dwellTime, conversationId, ...props }) => {
  const MAX_HINTS = 20;
  const [hints, setHints] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);

  useEffect(() => {
    if (!conversationId) return;

    const pusher = new Pusher(process.env.REACT_APP_PUSHER_KEY, {
      cluster: process.env.REACT_APP_PUSHER_CLUSTER
    });

    const channel = pusher.subscribe(`conversation-${conversationId}`);

    channel.bind('hint_ready', (data) => {
      console.log(`[Hints] Received: ${data.data.word}`);

      setHints(prev => {
        // FIFO: newest pushes out oldest
        const updated = [...prev, data.data];
        if (updated.length > MAX_HINTS) {
          return updated.slice(-MAX_HINTS);
        }
        return updated;
      });
    });

    channel.bind('hint_ready_complete', () => {
      setIsStreaming(false);
      if (props.onLoadingChange) props.onLoadingChange(false);
    });

    // ... rest similar to Suggestions
  }, [conversationId]);

  // ... rest of component
};
```

## Implementation Steps

1. ✅ **Add Groq dependency** - Updated `pyproject.toml` and upgraded to groq v0.37.0 (fixed httpx compatibility issue from v0.5.0)

2. ✅ **Create Groq client** - Created `conversations/utils_prompt_groq.py` with:
   - `stream_suggestions_with_tools()` - Streams 6 suggestions via tool calls
   - `stream_hints_with_tools()` - Streams 20 hints via tool calls
   - Tool-based streaming with JSON parsing
   - Lazy client initialization with `_get_groq_client()`

3. ✅ **Update API endpoints** - Updated `conversations/api.py` with:
   - `_stream_to_pusher()` helper function for background threading
   - `POST /api/conversations/{id}/suggestions/stream` endpoint
   - `POST /api/conversations/{id}/hints/stream` endpoint
   - Updated old endpoints to use Groq generators (backward compatibility)
   - Events: `suggestion_ready`, `hint_ready`, `*_complete`, `*_error`

4. ✅ **Remove OpenAI** - Renamed `utils_prompt_openai.py` to `.deprecated`, removed imports from `api.py`
   - Note: `utils_generators.py` and `utils_mock_conversations.py` still reference old code but are not used by streaming endpoints
   - `pyproject.toml` updated to use `groq` instead of `openai`

5. ✅ **Update frontend Suggestions** - Updated `keyboard-ui/src/components/Suggestions.js` with:
   - Pusher WebSocket integration for real-time updates
   - FIFO queue (newest suggestions push out oldest)
   - Skeleton loading states
   - Calls `/suggestions/stream` endpoint
   - Listens for `suggestion_ready`, `suggestion_ready_complete`, `suggestion_ready_error` events

6. ✅ **Update frontend Hints** - Updated `keyboard-ui/src/components/Hints.js` with:
   - Same Pusher WebSocket pattern
   - FIFO queue for 20 hints
   - Skeleton loading states
   - Calls `/hints/stream` endpoint
   - Listens for `hint_ready`, `hint_ready_complete`, `hint_ready_error` events

7. ⏸️ **Test** - Verify suggestions/hints stream correctly
   - Add `GROQ_API_KEY` to `.env`
   - Test in browser with conversation
   - Check console logs for streaming events
   - Verify suggestions/hints appear incrementally

8. ⏸️ **Deploy** - Add `GROQ_API_KEY` to production environment variables

## Key Advantages of Tool Call Approach

1. **No Manual JSON Parsing** - Groq handles structure, you get clean callbacks
2. **True Incremental Delivery** - Each suggestion arrives independently as generated
3. **Error Handling** - Tool call failures are isolated per-suggestion
4. **Parallel Hints & Suggestions** - Trigger both streams simultaneously
5. **Model Compliance** - LLM is explicitly instructed to call tool 6 times
6. **Type Safety** - Tool schema validates each suggestion

## Environment Variables Required

```bash
# .env
GROQ_API_KEY=your_groq_api_key_here
PUSHER_APP_ID=your_pusher_app_id
PUSHER_KEY=your_pusher_key
PUSHER_SECRET=your_pusher_secret
PUSHER_CLUSTER=us2  # or your cluster
```

## Testing Checklist

- [ ] Groq client initializes correctly
- [ ] Streaming endpoint returns immediately
- [ ] Pusher events are received in frontend
- [ ] Suggestions appear one-by-one in FIFO order
- [ ] Hints appear one-by-one in FIFO order
- [ ] Prefix filtering works correctly
- [ ] Hint text guidance works correctly
- [ ] Error handling shows appropriate messages
- [ ] Loading states display correctly
- [ ] Performance meets targets (<500ms first suggestion)

## Troubleshooting

### No suggestions appearing
- Check GROQ_API_KEY is set
- Check Pusher configuration
- Check browser console for WebSocket errors
- Check Django logs for streaming errors

### Slow performance
- Verify using `llama-3.3-70b-versatile` model
- Check network latency to Groq API
- Check Pusher event delivery times

### Tool calls not working
- Verify Groq model supports tool calls
- Check tool definition schema matches exactly
- Review Groq streaming logs for errors
