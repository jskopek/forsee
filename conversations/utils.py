from __future__ import annotations

import json
import os
import re
from typing import Any, Iterable, Tuple
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


def generate_reply_suggestions(
    conversation: Conversation | str,
    *,
    hint: str | None = None,
    count: int = 3,
) -> list[str]:
    """
    Produce a handful of short, ready-to-send reply options for the user.
    """
    conversation_obj = _get_conversation(conversation)
    messages = list(conversation_obj.messages.order_by("created_at", "id"))
    normalized_hint = (hint or "").strip()
    if len(normalized_hint) > 160:
        normalized_hint = normalized_hint[:160]
    profiles = _conversation_profiles(conversation_obj)
    history = _format_history(messages[-12:])
    system_prompt = (
        "You help the user choose their next message in a warm, supportive conversation. "
        "Return a JSON array of complete sentence suggestions that the user could send. "
        "Each suggestion must feel natural, compassionate, and specific to the situation. "
        "Keep suggestions under 40 words each."
    )
    prompt_payload = {
        "user_profile": profiles["user"],
        "contact_profile": profiles["contact"],
        "conversation_history": history,
        "desired_suggestion_count": count,
    }
    if normalized_hint:
        prompt_payload["user_hint"] = normalized_hint
        prompt_payload["hint_importance"] = (
            "The hint reflects what the user wants to talk about next. Heavily prioritize it."
        )

    suggestions: list[str] = []
    try:
        response_text = ask_openai(system_prompt, json.dumps(prompt_payload, indent=2))
        suggestions = _parse_suggestion_response(response_text)
    except Exception:
        suggestions = []

    suggestions = _clean_suggestions(suggestions)
    fallback = _fallback_suggestions(conversation_obj, messages, normalized_hint, count)
    for idea in fallback:
        if len(suggestions) >= count:
            break
        if idea not in suggestions:
            suggestions.append(idea)
    return suggestions[:count]


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


def ask_openai(system_prompt: str, user_prompt: str) -> str:
    if OpenAI is None:
        raise RuntimeError("OpenAI client is not available.")
    global _client  # noqa: PLW0603 - simple cache
    if _client is None:
        if not os.getenv("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY is not set.")
        _client = OpenAI()
    response = _client.responses.create(
        model=settings.OPENAI_RESPONSES_MODEL,
        temperature=OPENAI_TEMPERATURE,
        max_output_tokens=OPENAI_MAX_OUTPUT_TOKENS,
        input=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    )
    return _extract_text(response)


# Internal helpers -------------------------------------------------------------

def _build_greeting(conversation: Conversation, messages: list[Message]) -> str:
    profiles = _conversation_profiles(conversation)
    history = _format_history(messages)
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
    history = _format_history(messages)
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


def _parse_suggestion_response(raw: str) -> list[str]:
    cleaned = raw.strip()
    if not cleaned:
        return []
    candidates = [cleaned]
    if cleaned.startswith("```"):
        without_ticks = cleaned.strip("`")
        if without_ticks.lower().startswith("json"):
            without_ticks = without_ticks[4:]
        candidates.append(without_ticks.strip())
    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(data, list):
            return [str(item) for item in data]
        if isinstance(data, dict):
            suggestions = data.get("suggestions")
            if isinstance(suggestions, list):
                return [str(item) for item in suggestions]
    fallback_lines: list[str] = []
    for line in raw.splitlines():
        candidate = line.strip()
        if not candidate:
            continue
        candidate = candidate.lstrip("-•0123456789. ").strip()
        if candidate:
            fallback_lines.append(candidate)
    return fallback_lines


def _clean_suggestions(values: list[str]) -> list[str]:
    cleaned: list[str] = []
    for value in values:
        text = str(value).strip()
        if not text:
            continue
        normalized = " ".join(text.split())
        if normalized and normalized not in cleaned:
            cleaned.append(normalized)
    return cleaned


def _fallback_suggestions(
    conversation: Conversation,
    messages: list[Message],
    hint: str,
    count: int,
) -> list[str]:
    contact_name = (
        conversation.contact_snapshot.get("name")
        if conversation.contact_snapshot
        else conversation.contact.name
    ) or ""
    greeting_name = contact_name or "there"
    latest_contact = None
    for message in reversed(messages):
        if message.sender == Message.Sender.CONTACT:
            latest_contact = message
            break
    suggestions: list[str] = []
    if hint:
        suggestions.append(
            f"{contact_name or 'Hey'}, I'd really like to talk about {hint}. Can we focus on that together?"
        )
    if latest_contact:
        snippet = latest_contact.body.strip().splitlines()[0] if latest_contact.body else ""
        snippet = snippet.replace('"', "").strip()
        if snippet:
            snippet_display = snippet[:110] + ("..." if len(snippet) > 110 else "")
            suggestions.append(
                f"Thanks for sharing that. When you said \"{snippet_display}\", it meant a lot—how are you feeling about it now?"
            )
    suggestions.append(
        f"I'm grateful we're talking, {greeting_name}. What would feel most helpful for us to cover next?"
    )
    filler = [
        f"I appreciate you being here with me, {greeting_name}. Could we walk through that one more time?",
        f"Let me know what you need right now, {greeting_name}, and I'll do my best to help.",
    ]
    for option in filler:
        if len(suggestions) >= count:
            break
        suggestions.append(option)
    return suggestions[:count]


def _format_history(messages: Iterable[Message]) -> list[dict[str, str]]:
    history = []
    for message in messages:
        history.append(
            {
                "sender": message.sender,
                "body": message.body,
                "created_at": timezone.localtime(message.created_at).isoformat(),
            }
        )
    return history


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
        content = getattr(item, "content", None)
        if not content:
            continue
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


def normalize_interests(raw: Any) -> list[str]:
    if not raw:
        return []
    if isinstance(raw, (list, tuple)):
        return [str(item).strip() for item in raw if str(item).strip()]
    if isinstance(raw, str):
        cleaned = raw.replace("\r", "")
        if not cleaned.strip():
            return []
        parts = re.split(r"[\n;,]", cleaned)
        if len(parts) == 1:
            text = parts[0].strip()
            return [text] if text else []
        normalized: list[str] = []
        for part in parts:
            text = part.strip(" \t•*-")
            if text:
                normalized.append(text)
        return normalized
    text = str(raw).strip()
    return [text] if text else []
