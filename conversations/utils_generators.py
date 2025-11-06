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

    # --- System prompt: short, explicit, production-friendly ---
    system_prompt = (
        "You generate brief, natural spoken replies that the user will say aloud next.\n"
        "Hard rules:\n"
        f"- Output exactly {N_SUGGESTIONS} suggestions as a JSON array of strings.\n"
        f"- Each suggestion under {MAX_WORDS} words (space-separated word count).\n"
        "- Contractions allowed. No quotes, no emoji, no hashtags.\n"
        "- No emotional processing, advice-giving, meta-commentary, or reflection.\n"
        "- Do not broaden the topic or propose actions unless the hint requests it.\n"
        "- If a user_hint is present, it OVERRIDES conversation content and sets the reply goal.\n"
        "- Use conversation only for tone, names, and concrete details.\n"
        "- Match formality exactly:\n"
        "  casual → relaxed and friendly\n"
        "  polite → complete sentences, courteous\n"
        "  professional → clear, concise, neutral; no slang\n"
        "  warm → gentle, caring, soft tone\n"
        "  blunt → very short, direct, minimal words\n"
        "- If contact_name is provided, use it sparingly (≤1 in 3 suggestions).\n"
        "- If any suggestion exceeds the word limit, shorten it without changing intent.\n"
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

    # --- Strict schema with min=max=n ---
    schema = {
        "name": "reply_suggestions",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "suggestions": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": N_SUGGESTIONS,
                    "maxItems": N_SUGGESTIONS,
                }
            },
            "required": ["suggestions"],
            "additionalProperties": False,
        },
    }

    # --- Call model ---
    try:
        result = prompt_openai_structured(
            system_prompt,
            json.dumps(user_payload, ensure_ascii=False),
            schema=schema,
            # sensible defaults for speed/consistency:
            temperature=0.4,
            max_completion_tokens=70,
        )
        suggestions = result.get("suggestions", [])
        # Final sanitize: trim, enforce non-empty, enforce <= MAX_WORDS
        out: list[str] = []
        for s in suggestions:
            if isinstance(s, str):
                s = s.strip()
                if s and len(s.split()) <= MAX_WORDS:
                    out.append(s)
            if len(out) == N_SUGGESTIONS:
                break

        # If model overran word limit, try a light truncate fallback to keep count exact.
        # (Conservative: cut to first MAX_WORDS tokens.)
        if len(out) < N_SUGGESTIONS and isinstance(suggestions, list):
            for s in suggestions:
                if not isinstance(s, str):
                    continue
                s = " ".join(s.strip().split()[:MAX_WORDS])
                if s and s not in out:
                    out.append(s)
                if len(out) == N_SUGGESTIONS:
                    break

        return out[:N_SUGGESTIONS]
    except Exception as e:
        import logging
        logger = logging.getLogger(__name__)
        logger.error(f"Failed to generate suggestions: {type(e).__name__}: {e}")
        return []