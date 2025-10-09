from __future__ import annotations

import json
import os
from typing import Iterable

from django.utils import timezone

from .models import Conversation, Message

try:
    from openai import OpenAI
except ImportError:  # pragma: no cover - optional dependency
    OpenAI = None  # type: ignore[misc,assignment]

OPENAI_MODEL = "gpt-4o-mini"
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


def ask_openai(system_prompt: str, user_prompt: str) -> str:
    if OpenAI is None:
        raise RuntimeError("OpenAI client is not available.")
    global _client  # noqa: PLW0603 - simple cache
    if _client is None:
        if not os.getenv("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY is not set.")
        _client = OpenAI()
    response = _client.responses.create(
        model=OPENAI_MODEL,
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
