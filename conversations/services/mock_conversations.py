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
    "You craft face-to-face conversations between an ALS user and one of their contacts. "
    "Treat the exchange as spoken dialogue in the same room—include natural pauses, quick interjections, clarifying questions, and moments of shared attention. "
    "Reference the scene, body language, or nearby environment only when a speaker naturally folds it into their words. "
    "Always respond with strictly valid JSON using the provided schema, with sender values limited to 'user' or 'contact'. "
    "Keep language respectful, authentic, and emotionally grounded; let the conversation end organically once the shared goal or feeling has been met. "
    "Never include markdown, code fences, or narration outside of what the speakers say."
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
        relationship_category = _relationship_category(relationship)
        scenario_hint = _choose_scenario_hint(relationship_category)
        shared_interest = _choose_shared_interest_hint(
            user_snapshot.get("interests", []),
            contact_snapshot.get("interests", []),
        )
        environment = _choose_environment_hint(relationship_category)
        conversation_style = _choose_conversation_style(relationship_category)
        emotional_currents = _choose_emotional_current(relationship_category)
        small_talk_prompts = _choose_small_talk_prompts(relationship_category)
        conversation_beats = _build_conversation_beats(
            scenario_hint,
            shared_interest,
            relationship_category,
            small_talk_prompts,
        )
        speech_patterns = _choose_speech_patterns()
        relational_memory = _build_relational_memory(
            user_snapshot,
            contact_snapshot,
            shared_interest,
        )
        closing_guidance = random.choice(_CLOSING_GUIDANCE)

        payload = {
            "conversation_context": {
                "user": user_snapshot,
                "contact": contact_snapshot,
                "relationship": relationship,
                "notes": contact_snapshot.get("notes", ""),
                "personality": contact_snapshot.get("personality", ""),
                "relational_memory_prompts": relational_memory,
            },
            "scenario": {
                "seed": scenario_hint,
                "shared_interest": shared_interest,
                "time_context": random.choice(_TIME_CONTEXTS),
                "ambient_thread": random.choice(_AMBIENT_THREADS),
            },
            "scene": environment,
            "conversation_style": conversation_style,
            "emotional_currents": emotional_currents,
            "conversation_beats": conversation_beats,
            "small_talk_prompts": small_talk_prompts,
            "speech_cadence": speech_patterns,
            "structure_rules": {
                "target_message_count": target_turns,
                "max_message_count": max_turns,
                "max_total_words": max_words,
                "allow_shorter_if_resolved": True,
                "variation_guidance": random.choice(_VARIATION_GUIDANCE),
            },
            "tone_rules": {
                "contact_voice": _compose_contact_voice(contact_snapshot, conversation_style),
                "user_voice": _compose_user_voice(user_snapshot, conversation_style),
                "cadence": "Allow quick acknowledgements, half-finished thoughts, and fuller reflections when the moment calls for it.",
                "overlap": "Occasional interrupters or shared laughter can appear as ellipses or em dashes within a line—keep them purposeful.",
                "filler_guidance": "Natural spoken fillers ('you know', 'um', 'I mean') are acceptable sparingly when emotion spikes.",
                "addressing": "Use each other's names or nicknames at meaningful moments to anchor the in-person feel.",
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


def _relationship_category(relationship: str) -> str:
    relationship_lower = relationship.lower()
    if _relationship_matches(relationship_lower, _HEALTHCARE_KEYWORDS):
        return "healthcare"
    if _relationship_matches(relationship_lower, _FAMILY_KEYWORDS):
        return "family"
    if _relationship_matches(relationship_lower, _PROFESSIONAL_KEYWORDS):
        return "professional"
    if _relationship_matches(relationship_lower, _FRIENDSHIP_KEYWORDS):
        return "friend"
    return "general"


def _choose_scenario_hint(category: str) -> str:
    pool = _SCENARIO_POOLS.get(category, _GENERAL_SCENARIOS)
    return random.choice(pool)


def _relationship_matches(relationship: str, keywords: Sequence[str]) -> bool:
    return any(keyword in relationship for keyword in keywords if keyword)


def _choose_environment_hint(category: str) -> Dict[str, str]:
    pool = _ENVIRONMENT_POOLS.get(category, _ENVIRONMENT_POOLS["general"])
    return random.choice(pool)


def _choose_conversation_style(category: str) -> Dict[str, str]:
    pool = _CONVERSATION_STYLE_POOLS.get(category, _CONVERSATION_STYLE_POOLS["general"])
    return random.choice(pool)


def _choose_emotional_current(category: str) -> Dict[str, str]:
    pool = _EMOTIONAL_CURRENT_POOLS.get(category, _EMOTIONAL_CURRENT_POOLS["general"])
    return random.choice(pool)


def _choose_small_talk_prompts(category: str) -> List[str]:
    pool = _SMALL_TALK_POOLS.get(category, _SMALL_TALK_POOLS["general"])
    count = 2 if len(pool) >= 2 else len(pool)
    return random.sample(pool, k=count) if pool else []


def _choose_speech_patterns() -> List[str]:
    if not _SPEECH_PATTERN_PROMPTS:
        return []
    max_count = min(4, len(_SPEECH_PATTERN_PROMPTS))
    count = random.randint(3, max_count) if max_count >= 3 else max_count
    return random.sample(_SPEECH_PATTERN_PROMPTS, k=count)


def _build_conversation_beats(
    scenario_hint: str,
    shared_interest: str,
    category: str,
    small_talk_prompts: Sequence[str],
) -> List[str]:
    opener = (
        f"Ease in with {random.choice(small_talk_prompts)}"
        if small_talk_prompts
        else "Begin with a simple moment of noticing or a sensory cue from the shared space"
    )
    middle_anchor = scenario_hint.rstrip(".")
    if shared_interest:
        middle_anchor += f" while weaving in their shared interest in {shared_interest}"
    closing_prompt = random.choice(_WRAP_UP_PROMPTS.get(category, _WRAP_UP_PROMPTS["general"]))
    return [
        f"Opening: {opener}.",
        f"Middle: {middle_anchor}.",
        f"Closing: {closing_prompt}.",
    ]


def _build_relational_memory(
    user_snapshot: Dict[str, Any],
    contact_snapshot: Dict[str, Any],
    shared_interest: str,
) -> List[str]:
    memory_prompts: List[str] = []
    notes = contact_snapshot.get("notes", "").strip()
    personality = contact_snapshot.get("personality", "").strip()
    if notes:
        memory_prompts.append(
            f"Reference a recent detail from the contact's notes when it helps the story: {notes[:220]}."
        )
    if personality:
        memory_prompts.append(
            f"Let the contact's personality show through their phrasing: {personality[:220]}."
        )
    if shared_interest:
        memory_prompts.append(
            f"Include at least one concrete callback to their shared interest in {shared_interest}."
        )
    user_location = user_snapshot.get("location", "")
    if user_location:
        memory_prompts.append(
            f"Situate a moment in or around their location ({user_location}) if it fits naturally."
        )
    if not memory_prompts:
        memory_prompts.append(
            "Invent a small shared memory or running joke that would make sense for their relationship."
        )
    return memory_prompts


def _compose_contact_voice(contact_snapshot: Dict[str, Any], conversation_style: Dict[str, str]) -> str:
    relationship = contact_snapshot.get("relationship", "").strip().lower()
    personality = contact_snapshot.get("personality", "").strip()
    style_descriptor = conversation_style.get("contact_voice_hint", "")

    voice_bits: List[str] = []
    if relationship:
        voice_bits.append(f"Speaks like a {relationship} who knows the user well")
    else:
        voice_bits.append("Speaks with familiar ease")
    if personality:
        voice_bits.append(personality)
    if style_descriptor:
        voice_bits.append(style_descriptor)
    return "; ".join(bit for bit in voice_bits if bit)


def _compose_user_voice(user_snapshot: Dict[str, Any], conversation_style: Dict[str, str]) -> str:
    location = user_snapshot.get("location", "")
    style_descriptor = conversation_style.get("user_voice_hint", "")
    voice_bits = ["Authentic and agency-forward, letting emotion surface honestly"]
    if location:
        voice_bits.append(f"Carries the cadence of someone from {location}")
    if style_descriptor:
        voice_bits.append(style_descriptor)
    return "; ".join(bit for bit in voice_bits if bit)


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
    "Experimenting with a new breathing technique in the den, pausing to notice how it feels between tries.",
    "Settling in after a clinic visit, unpacking what the neurologist said while sharing tea at the kitchen table.",
    "Adjusting wheelchair positioning in the front room, weaving in laughs about the caregiver's clumsy toolbox.",
    "Mapping out the evening care routine while checking how energy levels shifted through the day.",
)

_FAMILY_SCENARIOS: Sequence[str] = (
    "Cooking dinner together, mixing practical updates with gossip about the family group chat.",
    "Sitting on the porch, sharing highs and lows from the week with no set agenda.",
    "Flipping through an old photo album and letting tangents spark new plans.",
    "Coordinating tomorrow's errands while joking about everyone's chronic lateness.",
)

_FRIEND_SCENARIOS: Sequence[str] = (
    "Setting up board game night on the coffee table while ribbing each other about old scores.",
    "Lazing in the living room with music on, swapping half-finished stories and ideas to try.",
    "Getting ready to head out to a community event, debating outfits and accessibility tweaks.",
    "Catching up on creative projects while the user's cat keeps interrupting the conversation.",
)

_PROFESSIONAL_SCENARIOS: Sequence[str] = (
    "Preparing slides together before a hybrid meeting, making sure accessibility feels right.",
    "Sharing a cab back from an advocacy event, decompressing and sketching next steps.",
    "Standing in the lab tinkering with new adaptive switches between real talk about workload.",
    "Grabbing coffee after work to revisit how the team handled a tough moment earlier.",
)

_GENERAL_SCENARIOS: Sequence[str] = (
    "Enjoying a quiet afternoon in the living room while rain taps the windows.",
    "Taking a breather after a busy morning, letting the chat wander wherever it wants.",
    "Relaxing in the backyard, drifting between practical plans and playful teasing.",
    "Pausing mid-errand to share how the day is really going before heading back out.",
)

_SCENARIO_POOLS: Dict[str, Sequence[str]] = {
    "healthcare": _HEALTHCARE_SCENARIOS,
    "family": _FAMILY_SCENARIOS,
    "professional": _PROFESSIONAL_SCENARIOS,
    "friend": _FRIEND_SCENARIOS,
    "general": _GENERAL_SCENARIOS,
}

_ENVIRONMENT_POOLS: Dict[str, Sequence[Dict[str, str]]] = {
    "healthcare": (
        {
            "setting": "Living room with medical equipment tucked nearby",
            "sensory_details": "soft whir of a ventilator and the clink of a ceramic mug on the side table",
            "proxemics": "contact sits angled toward the user's chair within easy reach",
        },
        {
            "setting": "Bedroom converted into a calm care space",
            "sensory_details": "filtered afternoon light, pill organizer open on the dresser",
            "proxemics": "they speak in low voices, leaning closer when questions need clarity",
        },
    ),
    "family": (
        {
            "setting": "Kitchen island with dinner halfway prepped",
            "sensory_details": "sizzle from a pan and the smell of garlic in the air",
            "proxemics": "moving side by side, glancing up to catch each other's expression",
        },
        {
            "setting": "Front porch swing",
            "sensory_details": "evening breeze, neighborhood sounds carrying over",
            "proxemics": "sitting shoulder to shoulder, turning slightly to stay face-to-face",
        },
    ),
    "friend": (
        {
            "setting": "Living room scattered with board games and blankets",
            "sensory_details": "background playlist humming softly and a bag of chips crinkling open",
            "proxemics": "lounging comfortably with easy eye contact and playful gestures",
        },
        {
            "setting": "Art studio corner set up with adaptive tools",
            "sensory_details": "faint smell of paint and brushes clinking in a jar",
            "proxemics": "friend leans in when excitement spikes, both grinning",
        },
    ),
    "professional": (
        {
            "setting": "Shared workspace table with laptops open",
            "sensory_details": "low hum of HVAC, distant chatter from colleagues changing shifts",
            "proxemics": "sitting across the table, swivelling screens toward each other",
        },
        {
            "setting": "Ride-share backseat after a site visit",
            "sensory_details": "city lights flashing by, quiet music from the driver",
            "proxemics": "angled toward each other over the seatbelt, speaking in softer tones",
        },
    ),
    "general": (
        {
            "setting": "Cozy den with warm lamp light",
            "sensory_details": "rain tapping the windows and a gentle heater fan in the corner",
            "proxemics": "user reclines while the contact settles nearby on an ottoman",
        },
        {
            "setting": "Backyard patio under string lights",
            "sensory_details": "crickets in the garden and ice clinking in glasses",
            "proxemics": "chairs angled toward each other to keep the conversation intimate",
        },
    ),
}

_CONVERSATION_STYLE_POOLS: Dict[str, Sequence[Dict[str, str]]] = {
    "healthcare": (
        {
            "label": "steady-coaching",
            "description": "Grounded support with space for worry to surface before they reset together.",
            "tempo": "measured but responsive",
            "contact_voice_hint": "keeps instructions plain yet threads in soft encouragement",
            "user_voice_hint": "names fatigue plainly while protecting their autonomy",
        },
        {
            "label": "clinical-debrief-with-heart",
            "description": "Detailed recap wrapped in personal care and in-jokes that lighten the load.",
            "tempo": "deliberate with bursts of quicker back-and-forth when clarity lands",
            "contact_voice_hint": "balances professional clarity with intimate knowledge of the user's routines",
            "user_voice_hint": "asks pointed questions, then relaxes into gratitude or humor",
        },
    ),
    "family": (
        {
            "label": "homey-weave",
            "description": "Chore chatter flowing into emotional check-ins and back again.",
            "tempo": "ebb-and-flow; short bursts mixed with reflective pauses",
            "contact_voice_hint": "teases gently and softens when vulnerability shows",
            "user_voice_hint": "mixes dry humor with candid updates about their body",
        },
        {
            "label": "porch-heart-to-heart",
            "description": "Unscripted conversation drifting between memories, plans, and unsaid worries.",
            "tempo": "slow build with occasional overlapping laughter or sighs",
            "contact_voice_hint": "leans on shared history to keep things grounded",
            "user_voice_hint": "lets emotions surface without losing clarity",
        },
    ),
    "friend": (
        {
            "label": "playful-nerd-out",
            "description": "Inside jokes collide with sincere care and geeky deep dives.",
            "tempo": "quick quips followed by longer story riffs",
            "contact_voice_hint": "bounces energy back, slips in comedic timing",
            "user_voice_hint": "rides the humor but signals needs the moment they arise",
        },
        {
            "label": "creative-sprawl",
            "description": "Conversation meanders like a brainstorming jam session.",
            "tempo": "medium pace with excited spikes when sparks appear",
            "contact_voice_hint": "mirrors enthusiasm and nudges the user toward trying things",
            "user_voice_hint": "shares vivid sensory details and emotionally honest reactions",
        },
    ),
    "professional": (
        {
            "label": "focused-collab",
            "description": "Practical problem solving tempered with awareness of energy limits.",
            "tempo": "task-oriented but allows spontaneous tangents about team dynamics",
            "contact_voice_hint": "stays solution-minded and checks for consent at each pivot",
            "user_voice_hint": "asserts expertise and flags access needs without apology",
        },
        {
            "label": "advocacy-debrief",
            "description": "Debriefing a big moment together while plotting the next bold move.",
            "tempo": "animated, with overlapping enthusiasm when they celebrate wins",
            "contact_voice_hint": "channels momentum and keeps the future in view",
            "user_voice_hint": "mixes strategic thinking with flashes of exhaustion and pride",
        },
    ),
    "general": (
        {
            "label": "slow-saturday",
            "description": "Loose conversation that finds meaning in the mundane details of the day.",
            "tempo": "unhurried cadence with soft pauses",
            "contact_voice_hint": "match the user's energy and offers gentle prompts",
            "user_voice_hint": "lets warmth and vulnerability coexist, even in small talk",
        },
        {
            "label": "cozy-check-in",
            "description": "Comfort-first dialogue that drifts into deeper territory naturally.",
            "tempo": "light, with stretches of companionable silence implied",
            "contact_voice_hint": "reassures through tone more than directives",
            "user_voice_hint": "shares gratitude, fears, and humor without a script",
        },
    ),
}

_EMOTIONAL_CURRENT_POOLS: Dict[str, Sequence[Dict[str, str]]] = {
    "healthcare": (
        {
            "baseline": "focused concern",
            "undercurrents": ["fatigue", "determination"],
            "arc": "builds towards relief once they co-create the plan.",
        },
        {
            "baseline": "measured optimism",
            "undercurrents": ["anxious curiosity", "mutual reassurance"],
            "arc": "peaks with a small shared win before winding down gently.",
        },
    ),
    "family": (
        {
            "baseline": "warm familiarity",
            "undercurrents": ["playful teasing", "protective worry"],
            "arc": "circles through laughter and lands on a promise to rest.",
        },
        {
            "baseline": "tired but hopeful",
            "undercurrents": ["gratitude", "occasional frustration at logistics"],
            "arc": "ends with a moment of mutual appreciation, not a formal plan.",
        },
    ),
    "friend": (
        {
            "baseline": "energetic camaraderie",
            "undercurrents": ["creative excitement", "quiet acknowledgement of limits"],
            "arc": "crests in shared inspiration, then softens into easygoing peace.",
        },
        {
            "baseline": "chill hangout",
            "undercurrents": ["nostalgia", "protective care"],
            "arc": "starts silly, dips into something real, returns to lightness.",
        },
    ),
    "professional": (
        {
            "baseline": "collaborative momentum",
            "undercurrents": ["strategic focus", "awareness of burnout"],
            "arc": "drives toward clarity on next steps with a grounded checkpoint.",
        },
        {
            "baseline": "thoughtful debrief",
            "undercurrents": ["shared pride", "concern about sustainability"],
            "arc": "moves from analysis into a mutual pep talk.",
        },
    ),
    "general": (
        {
            "baseline": "unhurried comfort",
            "undercurrents": ["light humor", "occasional melancholy"],
            "arc": "meanders until a small realization gives them both ease.",
        },
        {
            "baseline": "contented stillness",
            "undercurrents": ["gentle curiosity", "soft encouragement"],
            "arc": "builds a subtle emotional lift before tapering naturally.",
        },
    ),
}

_SMALL_TALK_POOLS: Dict[str, Sequence[str]] = {
    "healthcare": (
        "checking whether the new pillow height feels right",
        "laughing about the visitor badge still stuck to the contact's shirt",
        "comparing notes on how the clinic coffee tasted today",
    ),
    "family": (
        "mentioning the family group text chaos",
        "teasing about who keeps stealing leftovers",
        "commenting on the neighbor's dog sprinting across the yard again",
    ),
    "friend": (
        "cracking up about an inside joke from college",
        "complaining about a game's glitchy update",
        "rating the playlist that's been on repeat all afternoon",
    ),
    "professional": (
        "sharing a quick headline from industry news",
        "noting how cold the conference room always is",
        "remembering a teammate's running joke from the last meeting",
    ),
    "general": (
        "checking in about how the morning smoothie experiment turned out",
        "remarking on the weather doing something unexpected again",
        "laughing about the cat insisting on joining the conversation",
    ),
}

_WRAP_UP_PROMPTS: Dict[str, Sequence[str]] = {
    "healthcare": (
        "Anchor the close by confirming the immediate next care step without sounding clinical.",
        "Let the conversation land on a shared breath and a reminder that they're in it together.",
    ),
    "family": (
        "End with a casual shared plan or gentle reassurance that keeps the evening cozy.",
        "Wrap by acknowledging the help offered while keeping the mood light.",
    ),
    "friend": (
        "Finish with an invitation to keep hanging out or a playful dare for next time.",
        "Let the outro echo their inside jokes while reaffirming they have each other's back.",
    ),
    "professional": (
        "Close by locking in who does what next, then soften it with a personal note.",
        "End with mutual respect and a quick gut-check on energy before parting.",
    ),
    "general": (
        "Let the ending feel like easing back into comfortable silence in the same room.",
        "Close on a small appreciation or a plan to pick up the thread later tonight.",
    ),
}

_SPEECH_PATTERN_PROMPTS: Sequence[str] = (
    "Use occasional overlapping phrases or em dashes to hint at friendly interruptions.",
    "Allow one or two sentences to trail off with ellipses when thoughts taper or emotions swell.",
    "Mix complete sentences with fragments or single-word acknowledgements.",
    "Invite clarifying questions that sound natural, like repeating a word with a lift at the end.",
    "Sprinkle in grounded sensory references that matter to the speaker ('the kettle just clicked off').",
    "Include a soft filler or self-correction when the user rethinks how to express something important.",
)

_TIME_CONTEXTS: Sequence[str] = (
    "late morning with sunlight warming the room",
    "mid-afternoon lull while the neighborhood quiets down",
    "cozy evening after dinner dishes are stacked",
    "stormy weekend afternoon with rain on the roof",
    "calm weeknight just after caregivers left",
    "sunset wind-down while lights dim in the house",
    "early night when both are ready to slow their pace",
)

_AMBIENT_THREADS: Sequence[str] = (
    "the kettle clicking off in the kitchen",
    "a therapy dog snoring softly nearby",
    "rain streaking the windowpane",
    "fresh laundry folded on the couch between them",
    "notes from the day spread across the coffee table",
    "a sports game murmuring in the background with the sound muted",
    "candles flickering with a faint lavender scent",
)

_VARIATION_GUIDANCE: Sequence[str] = (
    "Let conversation lengths flex—some turns can be a breathy 'mm-hmm', others a story that unwinds over several sentences.",
    "Ride the emotional tempo: speed up when excitement hits, then slow down for reflection.",
    "Invite playful pivots or quiet detours when the relationship calls for it rather than staying on a single track.",
    "If the moment resolves early, taper rather than padding with filler.",
)

_CLOSING_GUIDANCE: Sequence[dict] = (
    {
        "instruction": "Let the wrap-up sound like two people sharing the same space, easing back into whatever comes next.",
        "acceptable_signoffs": [
            "Alright, let's settle in for a bit.",
            "I'll grab that from the kitchen.",
            "Thanks for sticking with me tonight.",
            "Give me a nudge if you need anything else.",
        ],
    },
    {
        "instruction": "Close once they confirm the next touchpoint, keeping the language spoken and warm.",
        "acceptable_signoffs": [
            "I'll check on you before I head out.",
            "Okay, tomorrow afternoon then.",
            "Sounds like a plan—I'll set it up.",
            "Call out if you want to keep talking.",
        ],
    },
    {
        "instruction": "End with an appreciative or playful note that matches the mood without resorting to text-style send-offs.",
        "acceptable_signoffs": [
            "You always know how to hype me up.",
            "I've got your back—right here.",
            "Let's keep the good part going.",
            "Alright, I'm not going far.",
        ],
    },
)
