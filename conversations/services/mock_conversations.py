from __future__ import annotations

import json
import os
import random
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Sequence, TYPE_CHECKING

try:
    from openai import OpenAI as _OpenAIClient
except ModuleNotFoundError:  # pragma: no cover - optional dependency
    _OpenAIClient = None

if TYPE_CHECKING:  # pragma: no cover - typing aid
    from openai import OpenAI
    from accounts.models import User
    from contacts.models import Contact
else:  # pragma: no cover - runtime fallback
    OpenAI = Any


DEFAULT_CONVERSATION_MODEL = os.getenv("OPENAI_MOCK_CONVERSATION_MODEL", "gpt-4.1-mini")
DEFAULT_CONVERSATION_TEMPERATURE = float(os.getenv("OPENAI_MOCK_CONVERSATION_TEMPERATURE", "0.85"))
DEFAULT_CONVERSATION_MAX_OUTPUT_TOKENS = int(os.getenv("OPENAI_MOCK_CONVERSATION_MAX_OUTPUT_TOKENS", "1400"))
DEFAULT_MIN_TURNS = int(os.getenv("OPENAI_MOCK_CONVERSATION_MIN_TURNS", "6"))
DEFAULT_MAX_TURNS = int(os.getenv("OPENAI_MOCK_CONVERSATION_MAX_TURNS", "26"))
DEFAULT_MAX_WORDS = int(os.getenv("OPENAI_MOCK_CONVERSATION_MAX_WORDS", "5000"))

_SYSTEM_PROMPT = (
    "You write realistic, empathetic conversations between an ALS user and one of their contacts. "
    "Always respond with strictly valid JSON using the provided schema. "
    "Messages should feel natural, grounded in the context provided, and end organically once the conversation goal is met. "
    "Use only 'user' or 'contact' as the sender values, and avoid markdown or code fences in message bodies."
)


class MockConversationError(RuntimeError):
    """Raised when we cannot build a mock conversation transcript from OpenAI."""


@dataclass(frozen=True)
class MockConversationMessage:
    sender: str
    body: str

    def normalised_sender(self) -> str:
        sender = self.sender.strip().lower()
        if sender in {"user", "contact"}:
            return sender
        if sender in {"patient", "als_user", "als user", "speaker", "writer"}:
            return "user"
        if sender in {"caregiver", "companion", "friend", "provider", "therapist"}:
            return "contact"
        return "contact"


@dataclass(frozen=True)
class MockConversationTranscript:
    title: str
    summary: str
    messages: List[MockConversationMessage]

    def trimmed(self, *, max_messages: int = 50, max_words: int = DEFAULT_MAX_WORDS) -> "MockConversationTranscript":
        if max_messages <= 0:
            max_messages = 50
        if max_words <= 0:
            max_words = DEFAULT_MAX_WORDS

        trimmed_messages: List[MockConversationMessage] = []
        words_used = 0

        for message in self.messages:
            body = message.body.strip()
            if not body:
                continue
            if len(trimmed_messages) >= max_messages:
                break
            message_word_count = _count_words(body)
            if words_used + message_word_count > max_words and trimmed_messages:
                break
            trimmed_messages.append(
                MockConversationMessage(sender=message.normalised_sender(), body=body)
            )
            words_used += message_word_count

        if not trimmed_messages and self.messages:
            first = self.messages[0]
            trimmed_messages.append(
                MockConversationMessage(sender=first.normalised_sender(), body=first.body.strip())
            )

        return MockConversationTranscript(
            title=self.title,
            summary=self.summary,
            messages=trimmed_messages,
        )


class MockConversationGenerator:
    def __init__(
        self,
        *,
        client: OpenAI | None = None,
        model: str = DEFAULT_CONVERSATION_MODEL,
        temperature: float = DEFAULT_CONVERSATION_TEMPERATURE,
        max_output_tokens: int = DEFAULT_CONVERSATION_MAX_OUTPUT_TOKENS,
    ):
        if client is not None:
            self.client = client
        else:
            if _OpenAIClient is None:
                raise MockConversationError(
                    "OpenAI client is not available. Install the 'openai' package or pass an explicit client."
                )
            self.client = _OpenAIClient()
        self.model = model
        self.temperature = temperature
        self.max_output_tokens = max_output_tokens

    def generate(
        self,
        *,
        user: "User",
        contact: "Contact",
        min_turns: int = DEFAULT_MIN_TURNS,
        max_turns: int = DEFAULT_MAX_TURNS,
        max_words: int = DEFAULT_MAX_WORDS,
    ) -> MockConversationTranscript:
        if max_turns > 50:
            max_turns = 50
        if min_turns < 2:
            min_turns = 2
        if min_turns > max_turns:
            min_turns = max_turns
        if max_words <= 0:
            max_words = DEFAULT_MAX_WORDS

        target_turns = random.randint(min_turns, max_turns)
        prompt_payload = self._build_prompt_payload(
            user=user,
            contact=contact,
            target_turns=target_turns,
            max_turns=max_turns,
            max_words=max_words,
        )

        response = self.client.responses.create(
            model=self.model,
            temperature=self.temperature,
            max_output_tokens=self.max_output_tokens,
            input=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": prompt_payload},
            ],
        )

        raw_text = _extract_output_text(response)
        payload = _parse_json_payload(raw_text)
        transcript = _coerce_transcript(payload)
        return transcript.trimmed(max_messages=max_turns, max_words=max_words)

    def _build_prompt_payload(
        self,
        *,
        user: "User",
        contact: "Contact",
        target_turns: int,
        max_turns: int,
        max_words: int,
    ) -> str:
        user_snapshot = _build_user_snapshot(user)
        contact_snapshot = _build_contact_snapshot(contact)
        relationship = contact_snapshot.get("relationship", "")
        scenario_hint = _choose_scenario_hint(relationship)
        shared_interest = _choose_shared_interest_hint(
            user_snapshot.get("interests", []),
            contact_snapshot.get("interests", []),
        )
        closing_guidance = random.choice(_CLOSING_GUIDANCE)

        payload = {
            "conversation_context": {
                "user": user_snapshot,
                "contact": contact_snapshot,
                "relationship": relationship,
                "notes": contact_snapshot.get("notes", ""),
                "personality": contact_snapshot.get("personality", ""),
            },
            "scenario": {
                "seed": scenario_hint,
                "shared_interest": shared_interest,
                "time_context": random.choice(_TIME_CONTEXTS),
            },
            "structure_rules": {
                "target_message_count": target_turns,
                "max_message_count": max_turns,
                "max_total_words": max_words,
                "allow_shorter_if_resolved": True,
                "variation_guidance": random.choice(_VARIATION_GUIDANCE),
            },
            "tone_rules": {
                "contact_voice": "grounded, attentive, and aligned with their role",
                "user_voice": "authentic, balancing vulnerability with agency",
                "message_length": "1-4 sentences each",
                "respectful_language": True,
                "avoid_generic_fillers": True,
            },
            "closing_guidance": closing_guidance,
            "output_schema": {
                "title": "string (max 80 characters, natural conversation label)",
                "summary": "string (2 sentences summarising the conversation)",
                "messages": [
                    {
                        "sender": "'user' or 'contact'",
                        "body": "string (plain text, no markdown, no stage directions)",
                    }
                ],
            },
        }

        return json.dumps(payload, indent=2)


def _build_user_snapshot(user: "User") -> Dict[str, Any]:
    return {
        "id": _serialize_pk(getattr(user, "pk", None)),
        "full_name": (user.full_name or "").strip(),
        "email": (user.email or "").strip(),
        "location": (user.location or "").strip(),
        "medical_condition": _compact_text(getattr(user, "medical_condition", "")),
        "interests": _split_text_block(getattr(user, "interests", "")),
        "sports_teams": _split_text_block(getattr(user, "sports_teams", "")),
    }


def _build_contact_snapshot(contact: "Contact") -> Dict[str, Any]:
    return {
        "id": _serialize_pk(getattr(contact, "pk", None)),
        "name": (contact.name or "").strip(),
        "relationship": (contact.relationship or "").strip(),
        "notes": _compact_text(getattr(contact, "notes", "")),
        "interests": _split_text_block(getattr(contact, "interests", "")),
        "personality": _compact_text(getattr(contact, "personality", "")),
    }


def _choose_scenario_hint(relationship: str) -> str:
    relationship_lower = relationship.lower()

    if _relationship_matches(relationship_lower, _HEALTHCARE_KEYWORDS):
        pool = _HEALTHCARE_SCENARIOS
    elif _relationship_matches(relationship_lower, _FAMILY_KEYWORDS):
        pool = _FAMILY_SCENARIOS
    elif _relationship_matches(relationship_lower, _PROFESSIONAL_KEYWORDS):
        pool = _PROFESSIONAL_SCENARIOS
    elif _relationship_matches(relationship_lower, _FRIENDSHIP_KEYWORDS):
        pool = _FRIEND_SCENARIOS
    else:
        pool = _GENERAL_SCENARIOS

    return random.choice(pool)


def _relationship_matches(relationship: str, keywords: Sequence[str]) -> bool:
    return any(keyword in relationship for keyword in keywords if keyword)


def _choose_shared_interest_hint(user_interests: Sequence[str], contact_interests: Sequence[str]) -> str:
    pool: List[str] = []
    pool.extend(item for item in user_interests if item)
    pool.extend(item for item in contact_interests if item)
    if not pool:
        return ""
    return random.choice(pool)


def _extract_output_text(response) -> str:
    try:
        if hasattr(response, "output_text") and response.output_text:
            return response.output_text.strip()
    except AttributeError:
        pass

    try:
        chunks = []
        for block in getattr(response, "output", []):
            block_type = getattr(block, "type", "")
            if block_type != "output_text":
                continue
            for piece in getattr(block, "content", []):
                text = getattr(piece, "text", None)
                if text:
                    chunks.append(text)
        if chunks:
            return "".join(chunks).strip()
    except AttributeError as error:
        raise MockConversationError("Unable to read text from OpenAI response") from error

    raise MockConversationError("OpenAI response did not contain any text output")


def _parse_json_payload(raw_text: str) -> dict:
    try:
        return json.loads(raw_text)
    except json.JSONDecodeError:
        trimmed = _slice_first_json_object(raw_text)
        if not trimmed:
            raise MockConversationError("OpenAI did not return valid JSON")
        try:
            return json.loads(trimmed)
        except json.JSONDecodeError as error:
            raise MockConversationError("OpenAI did not return valid JSON") from error


def _slice_first_json_object(raw_text: str) -> str | None:
    start = raw_text.find("{")
    end = raw_text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    return raw_text[start : end + 1]


def _coerce_transcript(payload: dict) -> MockConversationTranscript:
    if not isinstance(payload, dict):
        raise MockConversationError("OpenAI did not return a JSON object for the conversation.")

    title = str(payload.get("title", "")).strip()
    summary = str(payload.get("summary", "")).strip()
    raw_messages = payload.get("messages", [])

    if not isinstance(raw_messages, Iterable):
        raise MockConversationError("OpenAI did not include a messages array in the conversation.")

    messages: List[MockConversationMessage] = []

    for item in raw_messages:
        if not isinstance(item, dict):
            continue
        sender = str(item.get("sender", "")).strip() or "contact"
        body = str(item.get("body", "")).strip()
        if not body:
            continue
        message = MockConversationMessage(sender=sender, body=body)
        messages.append(message)

    if not messages:
        raise MockConversationError("OpenAI did not return any conversation messages.")

    if not title:
        title = _build_default_title(messages)
    if not summary:
        summary = _build_default_summary(messages)

    return MockConversationTranscript(title=title, summary=summary, messages=messages)


def _build_default_title(messages: Sequence[MockConversationMessage]) -> str:
    first = messages[0]
    if first.normalised_sender() == "contact":
        return "Conversation with contact"
    return "Conversation snapshot"


def _build_default_summary(messages: Sequence[MockConversationMessage]) -> str:
    preview = " ".join(message.body for message in messages[:2])
    preview_words = preview.split()
    if len(preview_words) > 40:
        preview_words = preview_words[:40]
    return "Conversation sample: " + " ".join(preview_words)


def _split_text_block(value: str) -> List[str]:
    if not value:
        return []
    results = []
    for line in value.splitlines():
        cleaned = line.strip()
        if cleaned.startswith("-"):
            cleaned = cleaned[1:].strip()
        if cleaned:
            results.append(cleaned)
    return results


def _compact_text(value: str) -> str:
    if not value:
        return ""
    cleaned = " ".join(value.split())
    return cleaned[:280] + "…" if len(cleaned) > 280 else cleaned


def _count_words(text: str) -> int:
    if not text:
        return 0
    return len([token for token in text.split() if token])


def _serialize_pk(value) -> str | None:
    if value is None:
        return None
    return str(value)


_HEALTHCARE_KEYWORDS: Sequence[str] = (
    "nurse",
    "doctor",
    "therapist",
    "slp",
    "speech",
    "respiratory",
    "neurologist",
    "clinician",
    "care",
    "case manager",
    "social worker",
    "pathologist",
    "ot",
    "pt",
)

_FAMILY_KEYWORDS: Sequence[str] = (
    "mother",
    "father",
    "mom",
    "dad",
    "sister",
    "brother",
    "daughter",
    "son",
    "spouse",
    "wife",
    "husband",
    "partner",
    "cousin",
    "aunt",
    "uncle",
    "family",
)

_FRIENDSHIP_KEYWORDS: Sequence[str] = (
    "friend",
    "buddy",
    "roommate",
    "neighbor",
    "mate",
    "pal",
    "college",
)

_PROFESSIONAL_KEYWORDS: Sequence[str] = (
    "coworker",
    "colleague",
    "manager",
    "boss",
    "supervisor",
    "team",
    "lab",
    "coach",
    "mentor",
    "advisor",
)

_HEALTHCARE_SCENARIOS: Sequence[str] = (
    "Reviewing treatment adjustments after a clinic visit and making sure the home routine feels achievable.",
    "Checking in about respiratory therapy exercises and deciding whether to tweak pacing or equipment settings.",
    "Coordinating how to introduce a new adaptive tool and planning a follow-up assessment.",
    "Discussing symptom tracking and deciding what to escalate before the next medical appointment.",
)

_FAMILY_SCENARIOS: Sequence[str] = (
    "Catching up after a recent visit and loosely planning the next family gathering.",
    "Balancing emotional support with practical caregiving updates from the day.",
    "Talking through a small challenge that came up this week and celebrating a meaningful win.",
    "Coordinating schedules for an upcoming outing while keeping energy in mind.",
)

_FRIEND_SCENARIOS: Sequence[str] = (
    "Planning a relaxed virtual hangout built around a shared hobby or interest.",
    "Swapping notes about a show, game, or podcast they both follow this week.",
    "Reminiscing about a favourite shared memory while trading current life updates.",
    "Brainstorming something fun to look forward to together soon.",
)

_PROFESSIONAL_SCENARIOS: Sequence[str] = (
    "Preparing for an upcoming work or research session and fine-tuning accessibility plans.",
    "Syncing on progress for a shared advocacy or community project and assigning next steps.",
    "Debriefing after a meeting to ensure the user felt included and heard.",
    "Sharing workplace updates and making sure communication flows smoothly.",
)

_GENERAL_SCENARIOS: Sequence[str] = (
    "Checking in on daily energy levels and finding moments of encouragement.",
    "Sharing how the day went, balancing practical updates with emotional presence.",
    "Planning for an upcoming milestone or appointment and what support will help.",
    "Offering a thoughtful surprise update to brighten the user's day.",
)

_TIME_CONTEXTS: Sequence[str] = (
    "early morning check-in",
    "midday update",
    "late afternoon debrief",
    "evening wind-down",
    "weekend catch-up",
    "post-appointment recap",
    "pre-visit planning session",
)

_VARIATION_GUIDANCE: Sequence[str] = (
    "Let the flow adapt to the scenario—shorter if it's a quick check, longer if emotions need space.",
    "Balance practical coordination with emotional presence; vary message length within the limits.",
    "Allow moments of humour or warmth if the relationship supports it, without losing authenticity.",
    "If the conversation feels complete before the target count, wrap up gracefully rather than padding.",
)

_CLOSING_GUIDANCE: Sequence[dict] = (
    {
        "instruction": "End as soon as both parties acknowledge next steps or share appreciation—no formal summary required.",
        "acceptable_signoffs": ["Talk soon!", "Thanks for checking in.", "Appreciate you.", "I'll message if anything changes."],
    },
    {
        "instruction": "Let the conversation taper once the plan is clear, using natural language like a text exchange.",
        "acceptable_signoffs": ["Sounds good to me.", "That helps a ton.", "Rest up, we'll reconnect.", "Ping me if you need anything."],
    },
    {
        "instruction": "Close with a warm but concise send-off linked to the scenario rather than a generic goodbye.",
        "acceptable_signoffs": ["I'll try that and let you know.", "Looking forward to it.", "Thanks for the encouragement.", "Catch you tomorrow."],
    },
)
