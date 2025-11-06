from __future__ import annotations

import json

from .models import Conversation, Message
from .utils_prompt_openai import prompt_openai, prompt_openai_structured


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


def generate_reply_suggestions(conversation: Conversation, hint: str | None = None, count: int = 3) -> list[str]:
    """
    Produce a handful of short, ready-to-send reply options for the user.
    """
    normalized_hint = (hint or "").strip()[:160]
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
        "user_profile": conversation.owner.get_profile_data(),
        "contact_profile": conversation.contact.get_profile_data(),
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
        # JSON Schema for OpenAI structured output
        schema = {
            "name": "reply_suggestions",
            "schema": {
                "type": "object",
                "properties": {
                    "suggestions": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                        "maxItems": 10,
                    }
                },
                "required": ["suggestions"],
                "additionalProperties": False,
            },
            "strict": True,
        }
        result = prompt_openai_structured(
            system_prompt,
            f"Return exactly {count} suggestions.\n\n" + json.dumps(prompt_payload, indent=2, ensure_ascii=False),
            schema=schema,
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

