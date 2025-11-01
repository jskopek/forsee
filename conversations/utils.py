from __future__ import annotations

import json
import os
import re
from typing import Any, Iterable, Tuple, TYPE_CHECKING
from django.http import HttpRequest

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .models import Conversation, Message
from .services.mock_conversations import (
    DEFAULT_MAX_TURNS,
    DEFAULT_MAX_WORDS,
    DEFAULT_MIN_TURNS,
    MockConversationGenerator,
    MockConversationTranscript,
)

if TYPE_CHECKING:
    from pydantic import BaseModel
    from .schemas import ReplySuggestions

try:
    from openai import OpenAI
except ImportError:  # pragma: no cover - optional dependency
    OpenAI = None  # type: ignore[misc,assignment]

OPENAI_TEMPERATURE = 0.7
OPENAI_MAX_OUTPUT_TOKENS = 400

_client = None


def generate_contact_greeting(conversation: Conversation | str) -> Message:
    conversation_obj = _get_conversation(conversation)
    messages = list(conversation_obj.messages.order_by("created_at", "id"))
    text = _build_greeting(conversation_obj, messages)
    message = conversation_obj.messages.create(
        sender=Message.Sender.CONTACT,
        body=text.strip() or _default_greeting(conversation_obj),
    )
    _touch_conversation(conversation_obj)
    return message


def generate_contact_reply(
    conversation: Conversation | str,
    *,
    trigger_message: Message | str | None = None,
) -> Message:
    conversation_obj = _get_conversation(conversation)
    messages = list(conversation_obj.messages.order_by("created_at", "id"))
    latest_user_message = _find_user_message(messages, trigger_message)
    if latest_user_message is None:
        message = conversation_obj.messages.create(
            sender=Message.Sender.CONTACT,
            body="I'm here whenever you're ready to continue the chat.",
        )
        _touch_conversation(conversation_obj)
        return message
    text = _build_reply(conversation_obj, messages, latest_user_message)
    message = conversation_obj.messages.create(
        sender=Message.Sender.CONTACT,
        body=text.strip() or _default_reply(latest_user_message),
    )
    _touch_conversation(conversation_obj)
    return message


def generate_reply_suggestions(conversation: Conversation, hint: str | None = None, count: int = 3) -> list[str]:
    """
    Produce a handful of short, ready-to-send reply options for the user.
    """
    normalized_hint = (hint or "").strip()[:160]
    profiles = _conversation_profiles(conversation)
    # Fetch only what we need for history and latest messages
    recent_min = list(
        conversation.messages.order_by("-created_at", "-id").values("sender", "body")[:12]
    )
    history = [{"sender": m["sender"], "body": m["body"]} for m in reversed(recent_min)]
    latest_contact_message = ""
    latest_user_message = ""
    for m in recent_min:  # already newest-first
        if not latest_contact_message and m["sender"] == Message.Sender.CONTACT:
            latest_contact_message = m["body"]
        if not latest_user_message and m["sender"] == Message.Sender.USER:
            latest_user_message = m["body"]
        if latest_contact_message and latest_user_message:
            break
    system_prompt = (
        "You are crafting next-line dialogue options for an eye-tracking keyboard user who is speaking in person with their contact. "
        "Think of this like dialogue choices in a role-playing game: each suggestion should represent a DIFFERENT DIRECTION the conversation could go. "
        "The three suggestions should feel like distinct branching paths, not three similar ways to say the same thing.\n\n"
        "Requirements:\n"
        "- Return a JSON array containing exactly the requested number of suggestions.\n"
        "- Each suggestion must be a single string under 40 words that can be spoken aloud naturally (no texting shorthand, no quotes, no emoji).\n"
        "- CRITICAL: Maximize diversity between suggestions. They should cover fundamentally different conversational intentions, such as:\n"
        "  * Expressing a feeling or personal reflection\n"
        "  * Asking a question to deepen understanding or get help\n"
        "  * Proposing a concrete action or next step\n"
        "  * Shifting to a related but different topic\n"
        "  * Offering support or acknowledgment to the contact\n"
        "  * Adding humor or lightness to the exchange\n"
        "- If a user hint is provided, use it as the TOPIC or THEME, but still create three DIFFERENT WAYS to engage with that topic. "
        "Don't make all three suggestions say the same thing about the hint—instead, show three distinct approaches (e.g., ask about it, share a feeling about it, propose action on it).\n"
        "- Keep the tone grounded in the existing relationship dynamic and the most recent turns."
    )
    prompt_payload = {
        "user_profile": profiles["user"],
        "contact_profile": profiles["contact"],
        "conversation_history": history,
        "desired_suggestion_count": count,
        "latest_contact_message": latest_contact_message,
        "latest_user_message": latest_user_message,
    }
    if normalized_hint:
        prompt_payload["user_hint"] = normalized_hint
        prompt_payload["hint_importance"] = (
            "The hint reflects what the user wants to talk about next. Use it as the central theme, "
            "but create THREE DIFFERENT WAYS to engage with this theme across your suggestions. "
            "For example, if the hint is 'cats', one suggestion might express a feeling about cats, "
            "another might ask a question about cats, and the third might propose doing something related to cats. "
            "The goal is maximum diversity of approach while respecting the hint as the topic."
        )

    try:
        from .schemas import REPLY_SUGGESTIONS_SCHEMA
        result = ask_openai_structured(
            system_prompt,
            f"Return exactly {count} suggestions.\n\n" + json.dumps(prompt_payload, indent=2, ensure_ascii=False),
            schema=REPLY_SUGGESTIONS_SCHEMA,
        )
        suggestions = result["suggestions"]  # guaranteed by schema
        return [s.strip() for s in suggestions[:count] if isinstance(s, str) and s.strip()]
    except Exception as e:
        # Log the error for debugging
        import logging
        logger = logging.getLogger(__name__)
        logger.error(f"Failed to generate suggestions: {type(e).__name__}: {e}")
        # If OpenAI fails, return empty - no fallbacks
        return []


# Conversation generation ------------------------------------------------------


def generate_mock_conversation_transcript(
    *,
    user,
    contact,
    generator: MockConversationGenerator | None = None,
    min_turns: int | None = None,
    max_turns: int | None = None,
    max_words: int | None = None,
) -> MockConversationTranscript:
    """
    Produce a synthetic yet human-feeling transcript for the given user/contact pair.
    """
    generator = generator or MockConversationGenerator()
    kwargs = {
        "user": user,
        "contact": contact,
        "min_turns": min_turns or DEFAULT_MIN_TURNS,
        "max_turns": max_turns or DEFAULT_MAX_TURNS,
        "max_words": max_words or DEFAULT_MAX_WORDS,
    }
    return generator.generate(**kwargs)


@transaction.atomic
def create_mock_conversation(
    *,
    user,
    contact,
    generator: MockConversationGenerator | None = None,
    min_turns: int | None = None,
    max_turns: int | None = None,
    max_words: int | None = None,
) -> Tuple[Conversation, MockConversationTranscript]:
    """
    Persist a newly generated conversation along with its transcript.
    """
    transcript = generate_mock_conversation_transcript(
        user=user,
        contact=contact,
        generator=generator,
        min_turns=min_turns,
        max_turns=max_turns,
        max_words=max_words,
    )
    trimmed = transcript.trimmed(
        max_messages=(max_turns or DEFAULT_MAX_TURNS),
        max_words=max_words or DEFAULT_MAX_WORDS,
    )
    conversation = Conversation.objects.create(
        owner=user,
        contact=contact,
        title=(trimmed.title or contact.name)[:255],
        user_snapshot=user.profile_data,
        contact_snapshot=contact.profile_data,
    )
    for message in trimmed.messages:
        sender = Message.Sender.USER if message.sender == "user" else Message.Sender.CONTACT
        conversation.messages.create(sender=sender, body=message.body)
    _touch_conversation(conversation)
    return conversation, trimmed


def ask_openai_structured(
    system_prompt: str,
    user_prompt: str,
    *,
    schema: dict | None = None,
) -> dict | list:
    """
    Request structured JSON output from OpenAI with optional JSON schema validation.
    
    Args:
        system_prompt: The system instruction
        user_prompt: The user query/request
        schema: Optional JSON schema dict for OpenAI to validate against
                If provided, response will be guaranteed to conform
    
    Returns:
        Parsed JSON as dict or list (no Pydantic overhead)
    
    Example:
        # Simple array of strings
        result = ask_openai_structured(
            system_prompt="You are a helpful assistant.",
            user_prompt="Generate 3 topic suggestions",
            schema={
                "name": "suggestions",
                "schema": {
                    "type": "object",
                    "properties": {
                        "items": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "List of suggestions"
                        }
                    },
                    "required": ["items"],
                    "additionalProperties": False
                },
                "strict": True
            }
        )
        suggestions = result["items"]
    """
    if OpenAI is None:
        raise RuntimeError("OpenAI client is not available.")
    
    global _client  # noqa: PLW0603 - simple cache
    if _client is None:
        if not os.getenv("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY is not set.")
        _client = OpenAI()

    model_name = settings.OPENAI_RESPONSES_MODEL
    
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    
    kwargs = {
        "model": model_name,
        "messages": messages,
    }
    
    # Add response format if schema provided
    if schema:
        kwargs["response_format"] = {"type": "json_schema", "json_schema": schema}
    
    # Adjust token limits based on model
    if "nano" in model_name.lower():
        kwargs["max_completion_tokens"] = 3000  # reasoning tokens need more space
    else:
        kwargs["max_completion_tokens"] = OPENAI_MAX_OUTPUT_TOKENS
        kwargs["temperature"] = OPENAI_TEMPERATURE
    
    response = _client.chat.completions.create(**kwargs)
    
    if not response.choices or len(response.choices) == 0:
        raise RuntimeError("No choices in API response")
    
    raw_content = response.choices[0].message.content or ""
    if not raw_content:
        raise RuntimeError("Empty response from API")
    
    try:
        return json.loads(raw_content)
    except json.JSONDecodeError as e:
        import logging
        logger = logging.getLogger(__name__)
        logger.error(f"Failed to parse JSON: {e}\nContent: {raw_content[:500]}")
        raise


def ask_openai(system_prompt: str, user_prompt: str) -> str:
    if OpenAI is None:
        raise RuntimeError("OpenAI client is not available.")
    global _client  # noqa: PLW0603 - simple cache
    if _client is None:
        if not os.getenv("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY is not set.")
        _client = OpenAI()

    model_name = settings.OPENAI_RESPONSES_MODEL

    # Use chat completions API for gpt-5-nano since responses API doesn't work well
    if "nano" in model_name.lower():
        # gpt-5-nano uses reasoning tokens, so we need much higher max_completion_tokens
        # to account for internal reasoning before the actual output
        response = _client.chat.completions.create(
            model=model_name,
            max_completion_tokens=2000,  # Higher limit for reasoning models
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )
        # Extract text from chat completion
        if response.choices and len(response.choices) > 0:
            return response.choices[0].message.content or ""
        return ""

    # Use responses API for other models
    params = {
        "model": model_name,
        "max_output_tokens": OPENAI_MAX_OUTPUT_TOKENS,
        "temperature": OPENAI_TEMPERATURE,
        "input": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }

    response = _client.responses.create(**params)
    return _extract_text(response)


# Internal helpers -------------------------------------------------------------

def _build_greeting(conversation: Conversation, messages: list[Message]) -> str:
    profiles = _conversation_profiles(conversation)
    history = [{"sender": m.sender, "body": m.body} for m in messages]
    system_prompt = (
        f"You are {profiles['contact'].get('name') or 'a trusted friend'} sending a short opening message to "
        f"{profiles['user'].get('full_name') or 'the user'}. Keep it warm and no more than three sentences."
    )
    user_prompt = json.dumps(
        {
            "user_profile": profiles["user"],
            "contact_profile": profiles["contact"],
            "conversation_history": history,
        },
        indent=2,
    )
    try:
        return ask_openai(system_prompt, user_prompt)
    except Exception:
        return _default_greeting(conversation)


def _build_reply(conversation: Conversation, messages: list[Message], latest_user_message: Message) -> str:
    profiles = _conversation_profiles(conversation)
    history = [{"sender": m.sender, "body": m.body} for m in messages]
    system_prompt = (
        f"You are {profiles['contact'].get('name') or 'a trusted friend'} replying to "
        f"{profiles['user'].get('full_name') or 'the user'}. Respond kindly and keep it under four sentences."
    )
    user_prompt = json.dumps(
        {
            "user_profile": profiles["user"],
            "contact_profile": profiles["contact"],
            "conversation_history": history,
            "latest_user_message": latest_user_message.body,
        },
        indent=2,
    )
    try:
        return ask_openai(system_prompt, user_prompt)
    except Exception:
        return _default_reply(latest_user_message)


def _conversation_profiles(conversation: Conversation) -> dict[str, dict]:
    user_profile = conversation.user_snapshot or getattr(conversation.owner, "profile_data", {})
    contact_profile = conversation.contact_snapshot or getattr(conversation.contact, "profile_data", {})
    return {"user": user_profile, "contact": contact_profile}

def _find_user_message(messages: list[Message], trigger: Message | str | None) -> Message | None:
    trigger_id = str(trigger.pk) if isinstance(trigger, Message) else (str(trigger) if trigger else None)
    if trigger_id:
        for message in messages:
            if str(message.pk) == trigger_id:
                return message
    for message in reversed(messages):
        if message.sender == Message.Sender.USER:
            return message
    return None


def _get_conversation(conversation: Conversation | str) -> Conversation:
    if isinstance(conversation, Conversation):
        return conversation
    return Conversation.objects.select_related("owner", "contact").get(pk=conversation)


def _touch_conversation(conversation: Conversation) -> None:
    conversation.last_response_job_id = ""
    conversation.updated_at = timezone.now()
    conversation.save(update_fields=["last_response_job_id", "updated_at"])


def _extract_text(response: object) -> str:
    output = getattr(response, "output", None) or getattr(response, "outputs", None) or []
    texts = []
    for item in output:
        # Handle ResponseOutputMessage items (type='message')
        item_type = getattr(item, "type", None)
        if item_type == "message":
            content = getattr(item, "content", None)
            if content:
                for chunk in content:
                    text = getattr(chunk, "text", None)
                    if text:
                        texts.append(text)
    return "\n".join(texts).strip()


def _default_greeting(conversation: Conversation) -> str:
    contact_name = conversation.contact_snapshot.get("name") if conversation.contact_snapshot else ""
    user_name = conversation.user_snapshot.get("full_name") if conversation.user_snapshot else ""
    return f"Hi {user_name or 'there'}, it's {contact_name or 'me'}. I wanted to check in and see how you're doing today."


def _default_reply(latest_user_message: Message) -> str:
    body = latest_user_message.body.strip()
    if not body:
        return "I'm here and ready whenever you want to share more."
    return f"Thanks for sharing that. I'm right here with you—tell me more about \"{body[:120]}\"."


# General utilities -------------------------------------------------------------


def is_htmx(request: HttpRequest) -> bool:
    return request.headers.get("HX-Request", "").lower() == "true"


def normalize_text_list(
    raw: Any,
    *,
    separators: str | Iterable[str] = r"[\n;,]",
    strip_chars: str = " \t•*-",
    allow_empty: bool = False,
    dedupe: bool = False,
    lowercase: bool = False,
) -> list[str]:
    """
    Convert a variety of list-like inputs into a list of clean strings.

    This helper is useful for normalizing fields like tags, interests, or skills
    that may come in as a delimited string, a list/tuple, or other primitive types.

    Behavior by input type:
    - Falsy values (None, "", [], etc.) -> []
    - list/tuple -> stringify each item, strip boundary characters, optionally lowercase,
      drop empty strings (unless allow_empty=True)
    - string -> split by provided separators, trim boundary characters, optionally lowercase,
      drop empty strings (unless allow_empty=True)
    - anything else -> stringify and trim; return [value] if non-empty (or allow_empty=True), else []

    Args:
        raw: The input value to normalize (str | list | tuple | Any).
        separators: Either a regex pattern string used with re.split, or an iterable
            of literal separator strings. Defaults to split on newlines, semicolons, or commas.
        strip_chars: Characters to strip from both ends of each item. Defaults to space,
            tab and common bullet characters (• * -).
        allow_empty: If True, keep empty strings that result from normalization.
        dedupe: If True, remove duplicate items while preserving order.
        lowercase: If True, lowercase each item after trimming.

    Returns:
        list[str]: A list of cleaned strings.
    """
    if not raw:
        return []

    def _maybe_add(target: list[str], value: str) -> None:
        if value or allow_empty:
            if dedupe:
                if value not in target:
                    target.append(value)
            else:
                target.append(value)

    def _clean(text: str) -> str:
        cleaned = text.strip(strip_chars)
        return cleaned.lower() if lowercase else cleaned

    # Precompute splitter
    splitter_pattern: str | None
    if isinstance(separators, str):
        splitter_pattern = separators
    else:
        escaped = [re.escape(sep) for sep in separators]
        splitter_pattern = "|".join(escaped) if escaped else None

    # Handle list/tuple
    if isinstance(raw, (list, tuple)):
        results: list[str] = []
        for item in raw:
            text = _clean(str(item))
            _maybe_add(results, text)
        return results

    # Handle string
    if isinstance(raw, str):
        cleaned_raw = raw.replace("\r", "")
        if not cleaned_raw.strip():
            return [""] if allow_empty else []
        parts: list[str]
        if splitter_pattern:
            parts = re.split(splitter_pattern, cleaned_raw)
        else:
            parts = [cleaned_raw]
        if len(parts) == 1:
            text = _clean(parts[0])
            return [text] if (text or allow_empty) else []
        results: list[str] = []
        for part in parts:
            text = _clean(part)
            if text or allow_empty:
                _maybe_add(results, text)
        return results

    # Fallback: stringify other types
    text = _clean(str(raw))
    return [text] if (text or allow_empty) else []


def normalize_interests(raw: Any) -> list[str]:
    """
    Normalize an "interests" field into a list of strings.

    This is a thin wrapper around normalize_text_list with defaults tuned for
    human-entered interest lists. It exists for backward compatibility and
    clarity at call sites.

    Examples:
        "music, hiking; chess" -> ["music", "hiking", "chess"]
        ["golf", " art "] -> ["golf", "art"]
    """
    return normalize_text_list(
        raw,
        separators=r"[\n;,]",
        strip_chars=" \t•*-",
        allow_empty=False,
        dedupe=False,
        lowercase=False,
    )
