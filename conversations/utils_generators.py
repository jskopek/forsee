from __future__ import annotations
import json
from typing import Annotated
from pydantic import Field
from django.conf import settings
from pydantic import BaseModel
from .models import Conversation, Message
from .utils_prompt_openai import prompt_openai


def generate_contact_greeting(conversation: Conversation) -> Message | None:
    messages = list(conversation.messages.order_by("created_at", "id"))
    system_prompt = (
        f"You are {conversation.contact.name or 'a trusted friend'} sending a short opening message to "
        f"{conversation.owner.full_name or 'the user'}. Keep it warm and no more than three sentences."
    )
    user_prompt = json.dumps({
        "user_profile": conversation.owner.get_profile_data(),
        "contact_profile": conversation.contact.get_profile_data(),
        "conversation_history": [{"sender": m.sender, "body": m.body} for m in messages],
    })
    text = prompt_openai(system_prompt, user_prompt)
    if text:
        message = conversation.messages.create(sender=Message.Sender.CONTACT, body=text)
        return message


def generate_contact_reply(conversation: Conversation, trigger_message: Message) -> Message | None:
    messages = list(conversation.messages.order_by("created_at", "id"))
    system_prompt = (
        f"You are {conversation.contact.name or 'a trusted friend'} replying to "
        f"{conversation.owner.full_name or 'the user'}. Respond kindly and keep it under four sentences."
    )
    user_prompt = json.dumps({
        "user_profile": conversation.owner.get_profile_data(),
        "contact_profile": conversation.contact.get_profile_data(),
        "conversation_history": [{"sender": m.sender, "body": m.body} for m in messages],
    })
    text = prompt_openai(system_prompt, user_prompt).strip()

    if text:
        message = conversation.messages.create(sender=Message.Sender.CONTACT, body=text)
        return message


def generate_reply_suggestions(conversation: Conversation, hint: str | None = None) -> list[str]:
    """
    Produce short, ready-to-speak reply options for in-person conversation.
    Prioritizes brevity, natural speech, and (when present) the user hint.
    """
    MAX_WORDS = 12
    N_SUGGESTIONS = 3
    MAX_HINT_LEN = 160
    HISTORY_TURNS = 10  # compact, fast

    # --- Normalize inputs ---
    normalized_hint = (hint or "").strip()[:MAX_HINT_LEN]

    contact = conversation.contact
    contact_name = getattr(contact, "name", None) or ""
    contact_formality = getattr(contact, "formality", None) or "casual"

    # Pull only what we need; build a compact transcript string:
    # "Contact: ..." / "You: ..." lines, newest last.
    qs = conversation.messages.order_by("-created_at", "-id").values("sender", "body")[:HISTORY_TURNS]
    recent = list(reversed(qs))

    def _role_line(sender: str, body: str) -> str:
        if sender == Message.Sender.CONTACT:
            return f"Contact: {body}".strip()
        else:
            return f"You: {body}".strip()

    transcript_lines = [_role_line(m["sender"], m["body"]) for m in recent if m.get("body")]
    transcript = "\n".join(transcript_lines)

    # --- Short, cache-friendly system prompt ---
    system_prompt = (
        "Write the user's next spoken lines.\n"
        "Return ONLY JSON that maps to the Pydantic model with one key: suggestions.\n"
        f"Suggestions must be {N_SUGGESTIONS} short strings (≤ {MAX_WORDS} words), natural speech, "
        "no emojis/hashtags/quotes. If user_hint exists, it overrides conversation content. "
        "Use conversation only for tone, names, and concrete details. "
        "Formality is one of: casual, polite, professional, warm, blunt. "
        "Use contact_name in at most one suggestion. Do not broaden the topic."
    )

    # --- Compact user payload ---
    user_payload = {
        "n": N_SUGGESTIONS,
        "formality": contact_formality,
        "contact_name": contact_name,
        "transcript": transcript,
    }
    if normalized_hint:
        user_payload["user_hint"] = normalized_hint

    class ReplySuggestions(BaseModel):
        """Exactly 3 string suggestions for reply options."""
        suggestions: Annotated[list[str], Field(min_length=3, max_length=3)]


    # --- Call model with Pydantic parsing ---
    try:
        parsed: ReplySuggestions = prompt_openai(
            system_prompt,
            json.dumps(user_payload, ensure_ascii=False),
            pydantic_model=ReplySuggestions,
            model_name=getattr(settings, "OPENAI_RESPONSES_MODEL", "gpt-4.1-mini"),
            temperature=0.3,
            max_output_tokens=200,
        )

        if not isinstance(parsed, ReplySuggestions):
            raise RuntimeError(f"Expected ReplySuggestions but got {type(parsed)}")

        # Minimal post-clean: trim whitespace, cap words
        out: list[str] = []
        for s in parsed.suggestions:
            s = " ".join(s.strip().split())
            out.append(" ".join(s.split()[:MAX_WORDS]))

        return out[:N_SUGGESTIONS]
    except Exception as e:
        import logging
        logger = logging.getLogger(__name__)
        logger.error(f"Failed to generate suggestions: {type(e).__name__}: {e}")
        return []


def generate_word_hints(conversation: Conversation) -> list[dict[str, str]]:
    """
    Generate single-word hints with emojis based on the last message and recent conversation context.
    Returns a list of dictionaries with 'word' and 'emoji' keys.
    Each hint should represent a possible response path or topic direction.
    """
    N_HINTS = 20  # Generate a good number of hints for the grid
    HISTORY_TURNS = 5  # Use last few messages for context

    contact = conversation.contact
    contact_name = getattr(contact, "name", None) or ""
    contact_formality = getattr(contact, "formality", None) or "casual"

    # Get recent messages for context
    qs = conversation.messages.order_by("-created_at", "-id").values("sender", "body")[:HISTORY_TURNS]
    recent = list(reversed(qs))

    def _role_line(sender: str, body: str) -> str:
        if sender == Message.Sender.CONTACT:
            return f"Contact: {body}".strip()
        else:
            return f"You: {body}".strip()

    transcript_lines = [_role_line(m["sender"], m["body"]) for m in recent if m.get("body")]
    transcript = "\n".join(transcript_lines)

    # Get the last message specifically
    last_message = recent[-1] if recent else None
    last_message_text = last_message.get("body", "") if last_message else ""

    system_prompt = (
        "Generate single-word hints with emojis that could help the user respond to the conversation.\n"
        "Each hint must be exactly ONE word (no spaces, no hyphens) paired with ONE relevant emoji.\n"
        "The hints should cover diverse possible response directions: emotions, actions, topics, questions, etc.\n"
        "Return ONLY JSON that maps to the Pydantic model with one key: hints.\n"
        "Each hint must have 'word' (single word, lowercase) and 'emoji' (single emoji character).\n"
        f"Generate {N_HINTS} diverse hints that explore many possible response paths.\n"
        "Focus on the last message but consider the conversation context for variety."
    )

    user_payload = {
        "n": N_HINTS,
        "formality": contact_formality,
        "contact_name": contact_name,
        "transcript": transcript,
        "last_message": last_message_text,
    }

    class WordHint(BaseModel):
        """A single word hint with an emoji."""
        word: str
        emoji: str

    class WordHints(BaseModel):
        """List of word hints."""
        hints: Annotated[list[WordHint], Field(min_length=1)]

    try:
        parsed: WordHints = prompt_openai(
            system_prompt,
            json.dumps(user_payload, ensure_ascii=False),
            pydantic_model=WordHints,
            model_name=getattr(settings, "OPENAI_RESPONSES_MODEL", "gpt-4.1-mini"),
            temperature=0.7,  # Higher temperature for more variety
            max_output_tokens=400,
        )

        if not isinstance(parsed, WordHints):
            raise RuntimeError(f"Expected WordHints but got {type(parsed)}")

        # Clean and validate hints
        out: list[dict[str, str]] = []
        seen_words = set()
        for hint in parsed.hints:
            # Ensure word is single word, lowercase, no spaces
            word = "".join(hint.word.lower().split())[:20]  # Max 20 chars, remove spaces
            if not word or word in seen_words:
                continue
            seen_words.add(word)
            
            # Ensure emoji is present (take first emoji if multiple provided)
            emoji = hint.emoji.strip()
            if not emoji:
                continue
            
            out.append({"word": word, "emoji": emoji})

        return out[:N_HINTS]
    except Exception as e:
        import logging
        logger = logging.getLogger(__name__)
        logger.error(f"Failed to generate word hints: {type(e).__name__}: {e}")
        return []