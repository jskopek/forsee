"""Pydantic schemas for structured LLM responses."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator


class ReplySuggestions(BaseModel):
    """Structured response for reply suggestions from LLM."""

    suggestions: list[str] = Field(
        ...,
        min_length=1,
        max_length=10,
        description="Short, ready-to-speak dialogue options under ~40 words each.",
    )

    @field_validator("suggestions")
    @classmethod
    def validate_suggestions(cls, v: list[str]) -> list[str]:
        """Ensure suggestions are non-empty strings."""
        if not v:
            raise ValueError("Must provide at least one suggestion")

        cleaned = []
        for suggestion in v:
            text = suggestion.strip()
            if not text:
                continue

            # Soft cap at 40 words - truncate if longer
            words = text.split()
            if len(words) > 40:
                text = " ".join(words[:40])

            cleaned.append(text)

        if not cleaned:
            raise ValueError("All suggestions were empty after cleaning")

        return cleaned


# JSON Schema for OpenAI structured output
REPLY_SUGGESTIONS_SCHEMA: dict[str, Any] = {
    "name": "reply_suggestions",
    "schema": {
        "type": "object",
        "properties": {
            "suggestions": {
                "type": "array",
                "items": {"type": "string"},
                "minItems": 1,
                "maxItems": 10,
                "description": (
                    "Array of short, ready-to-speak dialogue options. "
                    "Each suggestion must be under 40 words and sound natural when spoken aloud. "
                    "The suggestions should represent fundamentally different conversational directions."
                ),
            }
        },
        "required": ["suggestions"],
        "additionalProperties": False,
    },
    "strict": True,
}
