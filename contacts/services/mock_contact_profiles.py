import json
import os
import random
from dataclasses import dataclass
from typing import Any, Iterable, List, Sequence, TYPE_CHECKING

try:
    from openai import OpenAI as _OpenAIClient
except ModuleNotFoundError:  # pragma: no cover - optional dependency
    _OpenAIClient = None

if TYPE_CHECKING:  # pragma: no cover - typing aid
    from openai import OpenAI
else:
    OpenAI = Any

if TYPE_CHECKING:
    from contacts.models import Contact
    from home.models import PatientProfile


DEFAULT_CONTACT_MODEL = os.getenv("OPENAI_MOCK_CONTACT_MODEL", "gpt-4o-mini")
DEFAULT_CONTACT_TEMPERATURE = float(os.getenv("OPENAI_MOCK_CONTACT_TEMPERATURE", "0.85"))


@dataclass(frozen=True)
class ContactArchetype:
    label: str
    role_summary: str
    tone: str
    collaboration_focus: str
    signals: tuple[str, ...]


CONTACT_ARCHETYPES: Sequence[ContactArchetype] = (
    ContactArchetype(
        label="Primary neurologist",
        role_summary="Leads the ALS care plan, interprets disease progression data, and coordinates treatment pivots.",
        tone="Precise, clinically grounded, yet gently encouraging when celebrating incremental wins.",
        collaboration_focus="Transform clinic observations into actionable next steps and keep communication channels open.",
        signals=("neurologist", "doctor", "physician", "md"),
    ),
    ContactArchetype(
        label="Respiratory therapist",
        role_summary="Monitors breathing capacity, teaches airway clearance strategies, and tunes ventilatory support.",
        tone="Methodical and calm with a focus on safety and clear explanations.",
        collaboration_focus="Surface practical exercises, equipment tweaks, and check-in cadence.",
        signals=("respiratory", "rt", "ventilation", "breathing"),
    ),
    ContactArchetype(
        label="Speech-language pathologist",
        role_summary="Guides AAC strategies, articulatory exercises, and eye-tracking keyboard configurations.",
        tone="Optimistic coach who balances technical detail with creative communication ideas.",
        collaboration_focus="Highlight progress benchmarks, clever AAC hacks, and collaborative experimentation.",
        signals=("speech", "pathologist", "slp", "communication therapist"),
    ),
    ContactArchetype(
        label="Nurse case manager",
        role_summary="Coordinates day-to-day care logistics, liaises with specialists, and triages emerging concerns.",
        tone="Steady, pragmatic, and responsive with occasional warm humor to ease tense moments.",
        collaboration_focus="Make clear what information they monitor, how they escalate issues, and scheduling preferences.",
        signals=("nurse", "case manager", "rn"),
    ),
    ContactArchetype(
        label="Occupational therapist",
        role_summary="Finds creative adaptations for daily living, home setup, and assistive technology workflows.",
        tone="Inventive, collaborative, and hands-on problem solver.",
        collaboration_focus="Discuss current projects, adaptive experiments, and future skill-building ideas.",
        signals=("occupational", "ot"),
    ),
    ContactArchetype(
        label="Physical therapist",
        role_summary="Supports range-of-motion routines, positioning strategies, and energy management.",
        tone="Encouraging coach who tracks metrics but respects fatigue thresholds.",
        collaboration_focus="Reference tailored exercise variations, safety notes, and how they celebrate micro-improvements.",
        signals=("physical", "pt", "physio"),
    ),
    ContactArchetype(
        label="Palliative care social worker",
        role_summary="Helps the family navigate emotional labor, resources, and long-term planning with compassion.",
        tone="Grounded, empathetic, and direct when clarifying next steps.",
        collaboration_focus="Outline support programs, advocacy efforts, and how they center the patient's voice.",
        signals=("social worker", "palliative", "counselor"),
    ),
    ContactArchetype(
        label="Partner or spouse",
        role_summary="Coordinates daily routines, emotional support, and serves as the patient's closest confidant.",
        tone="Warm, conversational, and deeply attuned to subtle cues.",
        collaboration_focus="Share rituals, inside jokes, and how they balance caregiving with mutual hobbies.",
        signals=("partner", "spouse", "wife", "husband"),
    ),
    ContactArchetype(
        label="Adult child",
        role_summary="Juggles career or family life while supporting logistics, appointments, and morale.",
        tone="Reflective and determined with flashes of protective energy.",
        collaboration_focus="Mention coordination systems, boundary setting, and how they bring outside world updates.",
        signals=("daughter", "son", "child"),
    ),
    ContactArchetype(
        label="Sibling",
        role_summary="Offers lifelong perspective, family memory keeping, and shared humor.",
        tone="Playful and candid with deep loyalty.",
        collaboration_focus="Describe meaningful traditions, gentle rivalry, and how they advocate within family dynamics.",
        signals=("sibling", "brother", "sister"),
    ),
    ContactArchetype(
        label="Best friend from college",
        role_summary="Maintains social connection, sparks stimulating conversations, and plans inclusive hangouts.",
        tone="Chatty, imaginative, and quick with references from their shared history.",
        collaboration_focus="Surface overlapping interests, surprising new passions, and how they support spontaneity.",
        signals=("friend", "college", "best friend"),
    ),
    ContactArchetype(
        label="Coworker or lab collaborator",
        role_summary="Bridges professional identity with adaptive workflows and remote collaboration tactics.",
        tone="Curious, respectful of accessibility needs, and energized by joint projects.",
        collaboration_focus="Highlight shared goals, asynchronous tools, and how they champion inclusion at work.",
        signals=("coworker", "colleague", "collaborator", "lab"),
    ),
    ContactArchetype(
        label="Community volunteer or advocate",
        role_summary="Organizes support networks, raises awareness, and mobilizes resources for ALS initiatives.",
        tone="Purpose-driven, upbeat, and community minded.",
        collaboration_focus="Describe advocacy wins, creative fundraising, and mutual inspiration.",
        signals=("volunteer", "advocate", "community"),
    ),
    ContactArchetype(
        label="Neighbor",
        role_summary="Provides hyper-local support, fosters social connection, and keeps an eye on daily needs.",
        tone="Friendly, observant, and eager to help without being overbearing.",
        collaboration_focus="Mention neighborhood routines, drop-in systems, and seasonal check-ins.",
        signals=("neighbor",),
    ),
)


class MockContactProfileError(RuntimeError):
    """Raised when we cannot build a mock contact profile from OpenAI."""


@dataclass
class MockContactProfile:
    name: str
    relationship: str
    interests: List[str]
    personality: str
    notes: str

    def __post_init__(self) -> None:
        normalized_interests = _ensure_list(self.interests)
        object.__setattr__(self, "interests", normalized_interests)

    def as_contact_kwargs(self) -> dict:
        return {
            "name": self.name.strip(),
            "relationship": self.relationship.strip(),
            "interests": _join_list(self.interests),
            "personality": self.personality.strip(),
            "notes": self.notes.strip(),
        }


class MockContactProfileGenerator:
    def __init__(
        self,
        *,
        client: OpenAI | None = None,
        model: str = DEFAULT_CONTACT_MODEL,
        temperature: float = DEFAULT_CONTACT_TEMPERATURE,
        max_output_tokens: int = 650,
    ):
        if client is not None:
            self.client = client
        else:
            if _OpenAIClient is None:
                raise MockContactProfileError(
                    "OpenAI client is not available. Install the 'openai' package or pass an explicit client."
                )
            self.client = _OpenAIClient()
        self.model = model
        self.temperature = temperature
        self.max_output_tokens = max_output_tokens

    def generate(
        self,
        *,
        patient_profile: "PatientProfile",
        existing_contacts: Iterable["Contact"] | None = None,
    ) -> MockContactProfile:
        if existing_contacts is None:
            from contacts.models import Contact  # Local import to avoid circulars

            snapshot_contacts = list(Contact.objects.all())
        else:
            snapshot_contacts = list(existing_contacts)

        archetype = _select_archetype(snapshot_contacts)
        prompt = _build_prompt(patient_profile, snapshot_contacts, archetype)

        response = self.client.responses.create(
            model=self.model,
            temperature=self.temperature,
            max_output_tokens=self.max_output_tokens,
            input=[
                {
                    "role": "system",
                    "content": (
                        "You are designing a realistic contact profile for an ALS patient. "
                        "Blend medical accuracy with human warmth, respect privacy, and never trivialize lived experience. "
                        "Output valid JSON only."
                    ),
                },
                {
                    "role": "user",
                    "content": prompt,
                },
            ],
        )

        raw_text = _extract_output_text(response)
        payload = _parse_json_payload(raw_text)
        try:
            return MockContactProfile(**payload)
        except TypeError as error:
            raise MockContactProfileError("OpenAI response was missing required contact fields") from error


def _select_archetype(existing_contacts: Sequence["Contact"]) -> ContactArchetype:
    seen_relationships = []
    for contact in existing_contacts:
        if contact.relationship:
            seen_relationships.append(contact.relationship.lower())

    def archetype_unused(archetype: ContactArchetype) -> bool:
        if not seen_relationships:
            return True
        for relationship in seen_relationships:
            for signal in archetype.signals:
                if signal in relationship:
                    return False
        return True

    unused = [archetype for archetype in CONTACT_ARCHETYPES if archetype_unused(archetype)]
    pool = unused or list(CONTACT_ARCHETYPES)
    return random.choice(pool)


def _build_prompt(patient_profile: "PatientProfile", contacts: Sequence["Contact"], archetype: ContactArchetype) -> str:
    patient_snapshot = _build_patient_snapshot(patient_profile)
    contacts_digest = _build_contacts_digest(contacts)
    shared_touchpoints = _build_shared_touchpoints(patient_profile, contacts)

    relationship_directives = (
        f"- Relationship archetype to embody: {archetype.label}. "
        f"{archetype.role_summary}\n"
        f"- Tone guidance: {archetype.tone}\n"
        f"- Collaboration focus: {archetype.collaboration_focus}"
    )

    return (
        "We are building a synthetic yet believable contact for an ALS patient. "
        "The dataset powers an open-source conversational keyboard that speeds up communication for people who rely on eye tracking. "
        "Your contact should add fresh context, complement existing relationships, and surface meaningful conversational hooks.\n\n"
        "PATIENT SNAPSHOT:\n"
        f"{patient_snapshot}\n\n"
        "EXISTING CONTACTS:\n"
        f"{contacts_digest}\n\n"
        "SHARED TOUCHPOINT GUIDANCE:\n"
        f"{shared_touchpoints}\n\n"
        "RELATIONSHIP DIRECTIVES:\n"
        f"{relationship_directives}\n\n"
        "Instructions:\n"
        "- Introduce a new contact whose perspective genuinely benefits the patient.\n"
        "- Avoid repeating an existing contact's name or carbon-copying their role; if a similar role already exists, explain how this person differs.\n"
        "- Reference at least one shared interest or collaboration thread with the patient and introduce at least one interest that broadens their world.\n"
        "- Personality should read like a quick character sketch (2 sentences) aligned with the relationship tone.\n"
        "- Notes should be 2-3 sentences summarizing recent interactions, boundaries, and how they support communication goals.\n"
        "- Keep every detail respectful, specific, and resourceful.\n\n"
        "Return ONLY JSON using this exact shape:\n"
        "{"
        "\"name\": string,"
        "\"relationship\": string,"
        "\"interests\": [string, ...],"
        "\"personality\": string,"
        "\"notes\": string"
        "}."
    )


def _build_patient_snapshot(patient_profile: "PatientProfile") -> str:
    name = patient_profile.full_name or "Primary communicator"
    location = patient_profile.location.strip() if patient_profile.location else ""
    medical = _compact_text(patient_profile.medical_condition)
    interests = _split_text_block(patient_profile.interests)
    sports = _split_text_block(patient_profile.sports_teams)

    parts = [f"- Identifier: {name}"]
    if location:
        parts.append(f"- Location: {location}")
    if medical:
        parts.append(f"- Medical context: {medical}")
    if interests:
        parts.append(f"- Interests: {', '.join(interests[:6])}")
    if sports:
        parts.append(f"- Sports fandom: {', '.join(sports[:4])}")
    return "\n".join(parts) if parts else "- No patient details provided."


def _build_contacts_digest(contacts: Sequence["Contact"]) -> str:
    if not contacts:
        return "- None recorded yet."

    rows = []
    for contact in contacts[:6]:
        relationship = contact.relationship or "unspecified role"
        interest_list = _split_text_block(contact.interests)
        interest_preview = ", ".join(interest_list[:2]) if interest_list else ""
        notes = _compact_text(contact.notes)
        summary_bits = [relationship]
        if interest_preview:
            summary_bits.append(f"interests: {interest_preview}")
        if notes:
            summary_bits.append(f"notes: {notes}")
        summary = "; ".join(summary_bits)
        rows.append(f"- {contact.name}: {summary}")
    if len(contacts) > 6:
        rows.append(f"- (+{len(contacts) - 6} more contacts not listed)")
    return "\n".join(rows)


def _build_shared_touchpoints(patient_profile: "PatientProfile", contacts: Sequence["Contact"]) -> str:
    patient_interests = _split_text_block(patient_profile.interests)
    patient_sports = _split_text_block(patient_profile.sports_teams)

    already_used = []
    for contact in contacts:
        already_used.extend(_split_text_block(contact.interests))

    available_shared = [interest for interest in patient_interests if interest not in already_used]
    shared_samples = random.sample(available_shared, k=min(2, len(available_shared))) if available_shared else []
    shared_fallback = patient_interests[:2]
    shared = shared_samples or shared_fallback

    unique_prompts = [
        "Introduce an interest or expertise that gives the patient access to new resources or communities.",
        "Include a small detail about how they adapt communication styles for the patient's eye-tracking keyboard.",
        "Reference how they coordinate with the broader care team without duplicating someone else's duties.",
    ]

    lines = []
    if shared:
        lines.append(
            f"- Potential shared interests to weave in: {', '.join(shared)}."
        )
    elif patient_sports:
        lines.append(f"- Sports overlap to consider: {', '.join(patient_sports[:2])}.")
    else:
        lines.append("- Choose a shared interest that makes organic sense given the relationship.")

    lines.extend(f"- {prompt}" for prompt in unique_prompts)
    return "\n".join(lines)


def _compact_text(value: str) -> str:
    if not value:
        return ""
    cleaned = " ".join(value.split())
    return cleaned[:200] + "…" if len(cleaned) > 200 else cleaned


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


def _ensure_list(values) -> List[str]:
    if isinstance(values, list):
        iterable = values
    elif isinstance(values, tuple):
        iterable = list(values)
    elif isinstance(values, str):
        pieces = [piece.strip() for piece in values.replace(";", "\n").replace(",", "\n").splitlines()]
        iterable = [piece for piece in pieces if piece]
    else:
        iterable = [str(values).strip()]
    return [item for item in (value.strip() for value in iterable) if item]


def _join_list(values: Sequence[str]) -> str:
    cleaned = [value.strip() for value in values if value and value.strip()]
    if not cleaned:
        return ""
    return "\n".join(f"- {value}" for value in cleaned)


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
        raise MockContactProfileError("Unable to read text from OpenAI response") from error

    raise MockContactProfileError("OpenAI response did not contain any text output")


def _parse_json_payload(raw_text: str) -> dict:
    try:
        return json.loads(raw_text)
    except json.JSONDecodeError:
        trimmed = _slice_first_json_object(raw_text)
        if not trimmed:
            raise MockContactProfileError("OpenAI did not return valid JSON")
        try:
            return json.loads(trimmed)
        except json.JSONDecodeError as error:
            raise MockContactProfileError("OpenAI did not return valid JSON") from error


def _slice_first_json_object(raw_text: str) -> str | None:
    start = raw_text.find("{")
    end = raw_text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    return raw_text[start : end + 1]
