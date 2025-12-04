from __future__ import annotations

from uuid import UUID

from ninja import Router
from ninja.errors import HttpError
from pydantic import BaseModel, Field

from .models import Conversation, Message
from .utils_generators import generate_reply_suggestions, generate_word_hints

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


def get_conversation_or_404(conversation_id: UUID, user) -> Conversation:
    """Get conversation and verify user has access."""
    try:
        conversation = Conversation.objects.get(pk=conversation_id)
    except Conversation.DoesNotExist:
        raise HttpError(404, "Conversation not found")
    
    if conversation.owner != user and not user.is_superuser:
        raise HttpError(404, "Conversation not found")
    
    return conversation


@api_router.get("/{conversation_id}/hints", response=HintsResponse)
def get_hints(request, conversation_id: UUID):
    """
    Get word hints for a conversation.
    Returns a list of word-emoji pairs that can help the user respond.
    """
    if not request.user.is_authenticated:
        raise HttpError(401, "Authentication required")
    
    conversation = get_conversation_or_404(conversation_id, request.user)
    hints = generate_word_hints(conversation)
    
    return {
        "hints": [{"word": hint["word"], "emoji": hint["emoji"]} for hint in hints]
    }


@api_router.post("/{conversation_id}/suggestions", response=SuggestionsResponse)
def get_suggestions(request, conversation_id: UUID, body: SuggestionsRequest):
    """
    Get reply suggestions for a conversation.
    Optionally accepts a hint text to guide the suggestions.
    """
    if not request.user.is_authenticated:
        raise HttpError(401, "Authentication required")
    
    conversation = get_conversation_or_404(conversation_id, request.user)
    
    # Use hint and prefix from request body, or None if empty
    hint_text = body.hint.strip() if body.hint else None
    prefix_text = body.prefix.strip() if body.prefix else None
    suggestions = generate_reply_suggestions(conversation, hint_text, prefix_text)
    
    return {
        "suggestions": suggestions
    }


@api_router.post("/{conversation_id}/messages", response=MessageResponse)
def add_message(request, conversation_id: UUID, body: AddMessageRequest):
    """
    Add a message to a conversation.
    Optionally specify sender ('user' or 'contact'). If not provided, alternates from last message.
    """
    if not request.user.is_authenticated:
        raise HttpError(401, "Authentication required")
    
    conversation = get_conversation_or_404(conversation_id, request.user)
    
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
    if not request.user.is_authenticated:
        raise HttpError(401, "Authentication required")
    
    conversation = get_conversation_or_404(conversation_id, request.user)
    
    # Delete all messages and return count
    deleted_count, _ = conversation.messages.all().delete()
    
    return {"deleted_count": deleted_count}
