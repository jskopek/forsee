from __future__ import annotations

import json

from django.forms import model_to_dict

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


def generate_reply_suggestions(conversation: Conversation, hint: str | None = None) -> list[str]:
    """
    Produce a handful of short, ready-to-speak reply options for in-person conversation.
    Prioritizes brevity, natural speech, and the user's hint.
    """
    MAX_WORDS = 12
    normalized_hint = (hint or "").strip()[:160]


    system_prompt = (
        "You generate brief, natural spoken replies for an in-person conversation.\n"
        "These are quick things someone would actually say aloud.\n\n"
        "Hard rules:\n"
        f"- Keep each suggestion under {MAX_WORDS} words.\n"
        "- Sound casual and natural; contractions are fine.\n"
        "- No quotes, no emoji, no hashtags.\n"
        "- Do NOT do emotional processing, therapy talk, or self-reflection.\n"
        "- Do NOT propose activities, ask for help, or expand the topic unless the hint explicitly asks.\n"
        "- Respond directly to the most recent exchange. If a user hint is present, treat it as the primary intent.\n"
        "- Address the contact by first name only if contact.name is provided.\n"
        "- Return EXACTLY the requested number of suggestions as a JSON array of strings.\n\n"
        "Formality guide (match contact.formality):\n"
        "- casual → relaxed and friendly.\n"
        "- polite → soft edges, complete sentences.\n"
        "- professional → clear and neutral, avoid slang.\n"
        "- warm → gentle, caring, slightly affectionate.\n"
        "- blunt → minimal wording, direct.\n\n"
        "Examples of correct tone for hint='busy':\n"
        "- casual:  Hey, great to see you — I'm a bit busy right now.\n"
        "- polite:  Hello! I'm a little busy at the moment; can we chat soon?\n"
        "- professional:  Good to see you. I'm currently occupied but will follow up shortly.\n"
        "- warm:  Hey you — I'm tied up for a moment, but I’ll be right back.\n"
        "- blunt:  Busy right now. One minute.\n"
    )

    desired_suggestion_count = 3
    recent_messages = [{"sender": m["sender"], "body": m["body"]} for m in conversation.messages.order_by("-created_at").values("sender", "body")[:12]]
    prompt_payload = {
        "desired_suggestion_count": desired_suggestion_count,
        "contact": model_to_dict(conversation.contact, fields=["name", "relationship", "formality"]),
        "conversation_history": recent_messages,
        "latest_contact_message": _get_latest_message(recent_messages, from_sender=Message.Sender.CONTACT),
        "latest_user_message": _get_latest_message(recent_messages, from_sender=Message.Sender.USER),
    }
    if normalized_hint:
        prompt_payload["user_hint"] = normalized_hint
        prompt_payload["hint_policy"] = (
            "Use the hint as the main intent for the reply. "
            "Keep replies short and directly aligned to the hint. "
            "Do not broaden the topic or add reflective language."
        )

    try:
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
            f"Return exactly {desired_suggestion_count} suggestions.\n\n" + json.dumps(prompt_payload, indent=2, ensure_ascii=False),
            schema=schema,
        )
        suggestions = result["suggestions"]
        # Final sanitize: trim, enforce non-empty, drop anything too long
        out = []
        for s in suggestions:
            if isinstance(s, str):
                s = s.strip()
                if s and len(s.split()) <= MAX_WORDS:
                    out.append(s)
            if len(out) == desired_suggestion_count:
                break
        return out
    except Exception as e:
        import logging
        logger = logging.getLogger(__name__)
        logger.error(f"Failed to generate suggestions: {type(e).__name__}: {e}")
        return []


# Helpers
def _get_latest_message(message_history: list[dict], from_sender: Message.Sender | None = None) -> str:
    """
    Get the latest message body from message history, optionally filtered by sender.
    
    Args:
        message_history: List of message dicts with 'sender' and 'body' keys, ordered newest-first
        from_sender: Optional Message.Sender to filter by (e.g., Message.Sender.CONTACT, Message.Sender.USER)
    
    Returns:
        The body of the latest matching message, or empty string if none found
    """
    for message in message_history:
        if from_sender is None or message.get("sender") == from_sender:
            return message.get("body", "")
    return ""


