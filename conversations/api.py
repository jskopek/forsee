from __future__ import annotations

from uuid import UUID

from ninja import Router
from ninja.errors import HttpError
from pydantic import BaseModel, Field

from .models import Conversation
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
    
    # Use hint from request body, or None if empty
    hint_text = body.hint.strip() if body.hint else None
    suggestions = generate_reply_suggestions(conversation, hint_text)
    
    return {
        "suggestions": suggestions
    }
