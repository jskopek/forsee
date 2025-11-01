"""Helper functions for creating common structured schemas."""
from typing import Any


def json_schema(
    name: str,
    properties: dict[str, Any],
    required: list[str] | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    """
    Build a JSON schema dict compatible with OpenAI's structured outputs.
    
    Args:
        name: Schema name (required by OpenAI)
        properties: JSON Schema properties dict
        required: List of required property names (defaults to all)
        description: Schema description
    
    Returns:
        Dict ready to use in ask_openai_structured(schema=...)
    
    Example:
        schema = json_schema(
            name="suggestions",
            properties={
                "suggestions": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Suggestions"
                }
            },
            required=["suggestions"]
        )
    """
    return {
        "name": name,
        "schema": {
            "type": "object",
            "properties": properties,
            "required": required or list(properties.keys()),
            "additionalProperties": False,
            **({"description": description} if description else {})
        },
        "strict": True
    }


# Convenience builders for common patterns

def string_array_schema(
    name: str,
    field_name: str = "items",
    min_items: int = 1,
    max_items: int = 10,
    description: str | None = None,
) -> dict[str, Any]:
    """
    Create a schema for { "items": ["string", ...] }
    
    Example:
        schema = string_array_schema("suggestions", description="Conversation suggestions")
        result = ask_openai_structured(prompt, schema=schema)
        items = result["items"]
    """
    return json_schema(
        name=name,
        properties={
            field_name: {
                "type": "array",
                "items": {"type": "string"},
                "minItems": min_items,
                "maxItems": max_items,
                "description": description or "Array of strings"
            }
        },
        required=[field_name]
    )