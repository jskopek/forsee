import json
import os
import random
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, List, Sequence

try:
    from openai import OpenAI as _OpenAIClient
except ModuleNotFoundError:  # pragma: no cover - optional dependency
    _OpenAIClient = None

if TYPE_CHECKING:  # pragma: no cover - typing aid
    from openai import OpenAI
else:
    OpenAI = Any


DEFAULT_MODEL = os.getenv("OPENAI_MOCK_USER_MODEL", "gpt-4.1-mini")
DEFAULT_TEMPERATURE = float(os.getenv("OPENAI_MOCK_USER_TEMPERATURE", "0.9"))

YEARS_SINCE_DIAGNOSIS = list(range(1, 11))
PROGRESSION_OPTIONS = [
    "managing early-moderate progression with emerging mobility challenges",
    "living with a moderate stage that impacts fine motor skills and endurance",
    "navigating moderate-to-severe progression with pronounced upper limb weakness",
    "adapting to advanced progression with near-total limb paralysis",
    "balancing slow-progressing ALS with occasional plateau phases",
    "coping with fast-progressing ALS that accelerated after initial diagnosis",
]
SPEECH_ABILITY_OPTIONS = [
    "retains limited speech for short, effortful phrases but relies on assistive tech for full conversations",
    "experiences intermittent vocal clarity yet fatigues quickly, so eye-tracking tools handle most dialogue",
    "communicates primarily through synthesized speech due to severe dysarthria",
    "has no reliable natural speech but uses residual facial cues alongside the keyboard",
    "uses faint whispering for yes/no and leans on predictive text for richer responses",
]
SUPPORT_NETWORK_OPTIONS = [
    "coordinates daily routines with a partner plus rotating home-health aides",
    "lives with extended family who share caregiving responsibilities across the week",
    "relies on a professional caregiver team and remote care coordination via telehealth",
    "resides in an accessible apartment with visiting nurses and strong community volunteer support",
    "splits time between clinical visits and an adaptive technology lab at a local university",
    "engages in peer mentorship groups and online ALS forums for emotional support",
]
INTEREST_THEME_OPTIONS = [
    "retro video games and adaptive controllers",
    "bird watching and local conservation projects",
    "genealogy research and preserving family history",
    "college basketball fandom with detailed game analysis",
    "adaptive yoga and guided meditation practice",
    "storytelling through historical fiction writing",
    "mixing electronic music and producing podcasts",
    "urban sketching and plein air watercolor painting",
    "culinary experiments inspired by global cuisines",
    "tabletop role-playing campaigns with friends online",
    "volunteering for ALS fundraisers and advocacy coalitions",
    "virtual reality travel experiences and photography",
    "gardening with raised beds and hydroponic setups",
    "marine biology documentaries and citizen science projects",
    "crafting handmade gifts like pottery or fiber arts",
    "collecting and reviewing indie films or documentaries",
    "esports commentary and strategy forums",
    "local history tours and museum collaborations",
    "adaptive sailing and water therapy programs",
    "astronomy livestreams and night-sky observation",
    "binge-listening to investigative journalism podcasts",
    "hosting inclusive book clubs that highlight disabled authors",
    "competitive fantasy football analytics and draft strategy",
    "DIY smart home automation projects tuned for accessibility",
    "mentoring young coders through virtual hackathons",
    "organizing online poetry slams with synthesized voice performances",
    "writing culinary blogs that translate recipes into adaptive workflows",
    "fashion design using adaptive patterns and 3D printed accessories",
    "following Formula 1 racing with data-driven race breakdowns",
    "birdsong identification using spectrogram analysis tools",
    "leading virtual museum docent tours focused on accessibility",
    "participating in global chess tournaments through eye-tracking interfaces",
    "collaborating on indie game development narratives",
    "gene-editing ethics debates and biotech news roundups",
    "curating playlists that blend jazz with lo-fi instrumental beats",
    "staging social justice workshops for local advocacy groups",
    "writing travel memoirs that reinterpret past journeys",
    "hosting adaptive trivia nights for friends and family",
    "restoring vintage radios and cataloging their histories",
    "imbibing tea culture through sourcing rare leaves and rituals",
    "planning neighborhood accessibility audits with city planners",
    "producing audio documentaries about ALS lived experiences",
    "leading online mindfulness circles with visual breathing guides",
    "collecting vinyl records and digitizing rare tracks",
    "supporting wildlife rehabilitation centers through remote volunteering",
    "building miniature landscapes and model railroads",
    "practicing adaptive archery with custom-release mechanisms",
    "exploring astrophotography with remote telescope networks",
    "immersive language learning via adaptive flashcard systems",
    "participating in virtual cycling clubs with adaptive equipment",
    "moderating forums about disability policy and law reform",
    "experimenting with 3D printing to prototype assistive devices",
    "collecting comic books and reviewing graphic novel adaptations",
    "coordinating remote choir performances using synthesized vocals",
    "researching culinary anthropology and cultural food traditions",
    "crafting narrative podcasts about inclusive technology",
    "virtual volunteering for crisis text lines and peer support",
    "building custom mechanical keyboards tailored for caregivers",
    "following sustainable architecture trends and smart cities",
    "hosting online film critique salons for classic cinema",
    "participating in global citizen science climate monitoring projects",
    "documenting family oral histories with multimedia archives",
    "engaging in adaptive sailing simulator leagues",
    "writing speculative fiction that centers disabled heroes",
    "curating art therapy sessions with digital painting tools",
    "tracking endangered species through conservation databases",
    "creating mindfulness soundscapes with synthesizers",
    "supporting esports teams as a remote strategist",
    "managing community seed libraries and plant swaps",
    "organizing accessible hiking trail guides with crowd-sourced data",
    "producing ASMR content tailored for relaxation and focus",
    "coaching debate teams virtually on rhetoric and storytelling",
    "documenting street art photography projects",
    "analyzing public transit data to advocate for better routes",
    "leading inclusive philosophy discussion groups online",
    "creating adaptive cooking classes over livestream platforms",
    "experimenting with biofeedback apps for resilience training",
    "serving on advisory boards for inclusive game design",
]


class MockUserProfileError(RuntimeError):
    """Raised when we cannot build a mock user profile from OpenAI."""


@dataclass
class MockUserProfile:
    full_name: str
    location: str
    medical_condition: str
    interests: List[str]
    sports_teams: List[str]

    def as_user_kwargs(self) -> dict:
        return {
            "full_name": self.full_name,
            "location": self.location,
            "medical_condition": self.medical_condition.strip(),
            "interests": _join_list(self.interests),
            "sports_teams": _join_list(self.sports_teams),
        }


def _join_list(values: Sequence[str]) -> str:
    cleaned = [value.strip() for value in values if value and value.strip()]
    if not cleaned:
        return ""
    return "\n".join(f"- {value}" for value in cleaned)


class MockUserProfileGenerator:
    def __init__(
        self,
        *,
        client: OpenAI | None = None,
        model: str = DEFAULT_MODEL,
        temperature: float = DEFAULT_TEMPERATURE,
        max_output_tokens: int = 600,
    ):
        if client is not None:
            self.client = client
        else:
            if _OpenAIClient is None:
                raise MockUserProfileError(
                    "OpenAI client is not available. Install the 'openai' package or pass an explicit client."
                )
            self.client = _OpenAIClient()
        self.model = model
        self.temperature = temperature
        self.max_output_tokens = max_output_tokens

    def generate(self) -> MockUserProfile:
        directives = _build_variation_directives()

        response = self.client.responses.create(
            model=self.model,
            temperature=self.temperature,
            max_output_tokens=self.max_output_tokens,
            input=[
                {
                    "role": "system",
                    "content": (
                        "You are an expert researcher building detailed personas for people living "
                        "with moderate to severe ALS. Each persona should feel real, empathetic, "
                        "and respectful while highlighting daily life context, interests, and support needs. "
                        "Always respond with valid JSON only."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        "Generate a new persona for an adult ALS patient in the United States who relies on "
                        "advanced eye tracking keyboards with predictive text to communicate. "
                        "The persona will be used to test conversation features, so provide rich detail. "
                        "Explain the ALS background succinctly (progression level, speech abilities, support setup). "
                        "List at least four interests spanning hobbies, professional passions, and daily routines. "
                        "List one to three sports teams they follow (college, professional, local). "
                        "Focus on authenticity and optimism without minimizing challenges. "
                        f"{directives} "
                        "Return ONLY JSON with this exact shape and key order: "
                        "{"
                        "\"full_name\": string,"
                        "\"location\": string,"
                        "\"medical_condition\": string,"
                        "\"interests\": [string, ...],"
                        "\"sports_teams\": [string, ...]"
                        "}."
                    ),
                },
            ],
        )

        raw_text = _extract_output_text(response)

        payload = _parse_json_payload(raw_text)

        try:
            return MockUserProfile(**payload)
        except TypeError as error:
            raise MockUserProfileError("OpenAI response was missing required persona fields") from error


def _build_variation_directives() -> str:
    years = random.choice(YEARS_SINCE_DIAGNOSIS)
    progression = random.choice(PROGRESSION_OPTIONS)
    speech = random.choice(SPEECH_ABILITY_OPTIONS)
    support = random.choice(SUPPORT_NETWORK_OPTIONS)
    interest_count = random.randint(4, 5)
    interest_themes = random.sample(INTEREST_THEME_OPTIONS, k=interest_count)
    interest_prompt = "; ".join(interest_themes)
    return (
        "Persona variation directives:\n"
        f"- Diagnosis timeline: diagnosed {years} year{'s' if years != 1 else ''} ago.\n"
        f"- ALS progression focus: {progression}.\n"
        f"- Current speech ability: {speech}.\n"
        f"- Support network highlight: {support}.\n"
        f"- Interest story prompts: showcase passions such as {interest_prompt}, making sure each feels unique.\n"
        "Each interest string must be 1-2 sentences, describing the activity and why it matters to the persona.\n"
        "The medical_condition summary must explicitly reflect each directive while staying realistic and respectful."
    )


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
        raise MockUserProfileError("Unable to read text from OpenAI response") from error

    raise MockUserProfileError("OpenAI response did not contain any text output")


def _parse_json_payload(raw_text: str) -> dict:
    try:
        return json.loads(raw_text)
    except json.JSONDecodeError:
        trimmed = _slice_first_json_object(raw_text)
        if not trimmed:
            raise MockUserProfileError("OpenAI did not return valid JSON")
        try:
            return json.loads(trimmed)
        except json.JSONDecodeError as error:
            raise MockUserProfileError("OpenAI did not return valid JSON") from error


def _slice_first_json_object(raw_text: str) -> str | None:
    start = raw_text.find("{")
    end = raw_text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    return raw_text[start : end + 1]
