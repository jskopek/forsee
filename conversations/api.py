from __future__ import annotations

import threading
import logging
from uuid import UUID

from ninja import Router
from ninja.errors import HttpError
from pydantic import BaseModel, Field

from .models import Conversation, Message
from .utils_prompt_groq import stream_suggestions_with_tools, stream_hints_with_tools
from .signals import get_pusher_client

logger = logging.getLogger(__name__)

api_router = Router(tags=["conversations"])


class HintSchema(BaseModel):
    word: str
    emoji: str


class HintsResponse(BaseModel):
    hints: list[HintSchema]


class SuggestionsResponse(BaseModel):
    suggestions: list[str]


class SuggestionsRequest(BaseModel):
    hint: str | None = Field(default=None, description="Optional hint text to guide suggestions")
    prefix: str | None = Field(default=None, description="Optional prefix that all responses should start with")


class AddMessageRequest(BaseModel):
    body: str = Field(..., description="The message text content")
    sender: str | None = Field(default=None, description="Optional sender: 'user' or 'contact'. If not provided, alternates from last message.")


class MessageResponse(BaseModel):
    id: str
    sender: str
    body: str
    created_at: str


class ConversationContextMessage(BaseModel):
    id: str
    sender: str
    body: str
    created_at: str


class ConversationContextResponse(BaseModel):
    conversation_id: str
    title: str
    messages: list[ConversationContextMessage]


def get_conversation_or_404(conversation_id: UUID) -> Conversation:
    """Return a conversation or raise a 404 error."""
    try:
        return Conversation.objects.get(pk=conversation_id)
    except Conversation.DoesNotExist:
        raise HttpError(404, "Conversation not found")


@api_router.get("/{conversation_id}/context", response=ConversationContextResponse)
def get_conversation_context(request, conversation_id: UUID, limit: int = 12):
    """
    Lightweight conversation context for the keyboard UI.
    Returns the title and the most recent messages (oldest-first ordering).
    """
    conversation = get_conversation_or_404(conversation_id)

    qs = (
        conversation.messages
        .order_by("-created_at", "-id")
        .values("id", "sender", "body", "created_at")[:limit]
    )
    # Oldest-first for a readable transcript
    recent_messages = list(reversed(list(qs)))

    return {
        "conversation_id": str(conversation.id),
        "title": conversation.title or "",
        "messages": [
            {
                "id": str(m["id"]),
                "sender": m["sender"],
                "body": m["body"],
                "created_at": m["created_at"].isoformat() if m.get("created_at") else "",
            }
            for m in recent_messages
        ],
    }


@api_router.get("/{conversation_id}/hints", response=HintsResponse)
def get_hints(request, conversation_id: UUID):
    """
    Get word hints for a conversation (non-streaming).
    Returns a list of word-emoji pairs that can help the user respond.
    Note: For better performance, use /hints/stream endpoint instead.
    """
    conversation = get_conversation_or_404(conversation_id)

    # Collect all hints from streaming generator
    hints = list(stream_hints_with_tools(conversation))

    return {
        "hints": [{"word": hint["word"], "emoji": hint["emoji"]} for hint in hints]
    }


@api_router.post("/{conversation_id}/suggestions", response=SuggestionsResponse)
def get_suggestions(request, conversation_id: UUID, body: SuggestionsRequest):
    """
    Get reply suggestions for a conversation (non-streaming).
    Optionally accepts a hint text to guide the suggestions.
    Note: For better performance, use /suggestions/stream endpoint instead.
    """
    conversation = get_conversation_or_404(conversation_id)

    # Use hint and prefix from request body, or None if empty
    hint_text = body.hint.strip() if body.hint else None
    prefix_text = body.prefix.strip() if body.prefix else None

    # Collect all suggestions from streaming generator
    suggestions = list(stream_suggestions_with_tools(conversation, hint_text, prefix_text))

    return {
        "suggestions": suggestions
    }


@api_router.post("/{conversation_id}/messages", response=MessageResponse)
def add_message(request, conversation_id: UUID, body: AddMessageRequest):
    """
    Add a message to a conversation.
    Optionally specify sender ('user' or 'contact'). If not provided, alternates from last message.
    """
    conversation = get_conversation_or_404(conversation_id)
    
    # Validate body is not empty
    body_text = body.body.strip()
    if not body_text:
        raise HttpError(400, "Message body cannot be empty")
    
    # Determine sender
    if body.sender:
        # Validate sender value
        if body.sender not in [Message.Sender.USER, Message.Sender.CONTACT]:
            raise HttpError(400, f"Invalid sender. Must be '{Message.Sender.USER}' or '{Message.Sender.CONTACT}'")
        sender = body.sender
    else:
        # Alternate from last message
        last_message = conversation.messages.order_by('-created_at', '-id').first()
        if last_message is None:
            # No messages yet, default to user
            sender = Message.Sender.USER
        else:
            # Alternate: if last was user, next is contact; if last was contact, next is user
            if last_message.sender == Message.Sender.USER:
                sender = Message.Sender.CONTACT
            else:
                sender = Message.Sender.USER
    
    # Create the message
    message = Message.objects.create(
        conversation=conversation,
        sender=sender,
        body=body_text,
    )
    
    return {
        "id": str(message.id),
        "sender": message.sender,
        "body": message.body,
        "created_at": message.created_at.isoformat(),
    }


class ClearMessagesResponse(BaseModel):
    deleted_count: int


@api_router.delete("/{conversation_id}/messages", response=ClearMessagesResponse)
def clear_messages(request, conversation_id: UUID):
    """
    Delete all messages from a conversation.
    """
    conversation = get_conversation_or_404(conversation_id)

    # Delete all messages and return count
    deleted_count, _ = conversation.messages.all().delete()

    return {"deleted_count": deleted_count}


# ============================================================================
# STREAMING ENDPOINTS
# ============================================================================

class StreamingStatusResponse(BaseModel):
    status: str


def _stream_to_pusher(generator_func, channel_name, event_name, *args):
    """
    Helper to stream from generator to Pusher in a thread.
    This returns immediately while streaming happens in background.

    Args:
        generator_func: Generator function to call
        channel_name: Pusher channel name
        event_name: Base event name (e.g., 'suggestion_ready')
        *args: Arguments to pass to generator_func
    """
    pusher_client = get_pusher_client()
    if not pusher_client:
        logger.error("No Pusher client available for streaming")
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
            logger.info(f"Streaming complete: {index} items sent to {channel_name}/{event_name}")
        except Exception as e:
            logger.error(f"Streaming error: {e}", exc_info=True)
            pusher_client.trigger(channel_name, f"{event_name}_error", {
                'error': str(e)
            })

    # Start thread and return immediately
    thread = threading.Thread(target=_stream, daemon=True)
    thread.start()
    logger.info(f"Started streaming thread for {channel_name}/{event_name}")


@api_router.post("/{conversation_id}/suggestions/stream", response=StreamingStatusResponse)
def stream_suggestions(request, conversation_id: UUID, body: SuggestionsRequest):
    """
    Start streaming suggestions via Pusher.
    Returns immediately; suggestions arrive via WebSocket events.

    Events sent:
    - suggestion_ready: {index: int, data: str}
    - suggestion_ready_complete: {count: int}
    - suggestion_ready_error: {error: str}
    """
    conversation = get_conversation_or_404(conversation_id)

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


class HintsStreamRequest(BaseModel):
    exclude_words: list[str] | None = Field(default=None, description="Words to exclude from hint generation")


@api_router.post("/{conversation_id}/hints/stream", response=StreamingStatusResponse)
def stream_hints(request, conversation_id: UUID, body: HintsStreamRequest = None):
    """
    Start streaming hints via Pusher.
    Returns immediately; hints arrive via WebSocket events.

    Events sent:
    - hint_ready: {index: int, data: {word: str, emoji: str}}
    - hint_ready_complete: {count: int}
    - hint_ready_error: {error: str}
    """
    conversation = get_conversation_or_404(conversation_id)

    # Get excluded words from request body
    exclude_words = []
    if body and body.exclude_words:
        exclude_words = [word.lower().strip() for word in body.exclude_words if word.strip()]

    channel_name = f'conversation-{conversation_id}'

    _stream_to_pusher(
        stream_hints_with_tools,
        channel_name,
        'hint_ready',
        conversation,
        exclude_words
    )

    return {"status": "streaming"}
