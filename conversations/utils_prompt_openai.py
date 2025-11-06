from __future__ import annotations

import json
import os

from django.conf import settings

try:
    from openai import OpenAI
except ImportError:  # pragma: no cover - optional dependency
    OpenAI = None  # type: ignore[misc,assignment]

OPENAI_TEMPERATURE = 0.7
OPENAI_MAX_OUTPUT_TOKENS = 400

_client = None


def prompt_openai_structured(
    system_prompt: str,
    user_prompt: str,
    *,
    schema: dict | None = None,
) -> dict | list:
    """
    Request structured JSON output from OpenAI with optional JSON schema validation.
    
    Args:
        system_prompt: The system instruction
        user_prompt: The user query/request
        schema: Optional JSON schema dict for OpenAI to validate against
                If provided, response will be guaranteed to conform
    
    Returns:
        Parsed JSON as dict or list (no Pydantic overhead)
    
    Example:
        # Simple array of strings
        result = prompt_openai_structured(
            system_prompt="You are a helpful assistant.",
            user_prompt="Generate 3 topic suggestions",
            schema={
                "name": "suggestions",
                "schema": {
                    "type": "object",
                    "properties": {
                        "items": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "List of suggestions"
                        }
                    },
                    "required": ["items"],
                    "additionalProperties": False
                },
                "strict": True
            }
        )
        suggestions = result["items"]
    """
    if OpenAI is None:
        raise RuntimeError("OpenAI client is not available.")
    
    global _client  # noqa: PLW0603 - simple cache
    if _client is None:
        if not os.getenv("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY is not set.")
        _client = OpenAI()

    model_name = settings.OPENAI_RESPONSES_MODEL
    
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    
    kwargs = {
        "model": model_name,
        "messages": messages,
    }
    
    # Add response format if schema provided
    if schema:
        kwargs["response_format"] = {"type": "json_schema", "json_schema": schema}
    
    # Adjust token limits based on model
    if "nano" in model_name.lower():
        kwargs["max_completion_tokens"] = 3000  # reasoning tokens need more space
    else:
        kwargs["max_completion_tokens"] = OPENAI_MAX_OUTPUT_TOKENS
        kwargs["temperature"] = OPENAI_TEMPERATURE
    
    response = _client.chat.completions.create(**kwargs)
    
    if not response.choices or len(response.choices) == 0:
        raise RuntimeError("No choices in API response")
    
    raw_content = response.choices[0].message.content or ""
    if not raw_content:
        raise RuntimeError("Empty response from API")
    
    try:
        return json.loads(raw_content)
    except json.JSONDecodeError as e:
        import logging
        logger = logging.getLogger(__name__)
        logger.error(f"Failed to parse JSON: {e}\nContent: {raw_content[:500]}")
        raise


def prompt_openai(system_prompt: str, user_prompt: str) -> str | None:
    if OpenAI is None:
        raise RuntimeError("OpenAI client is not available.")
    global _client  # noqa: PLW0603 - simple cache
    if _client is None:
        if not os.getenv("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY is not set.")
        _client = OpenAI()

    model_name = settings.OPENAI_RESPONSES_MODEL

    # Use chat completions API for gpt-5-nano since responses API doesn't work well
    if "nano" in model_name.lower():
        # gpt-5-nano uses reasoning tokens, so we need much higher max_completion_tokens
        # to account for internal reasoning before the actual output
        response = _client.chat.completions.create(
            model=model_name,
            max_completion_tokens=2000,  # Higher limit for reasoning models
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
        )
        # Extract text from chat completion
        if response.choices and len(response.choices) > 0:
            return response.choices[0].message.content or ""
        return ""

    # Use responses API for other models
    params = {
        "model": model_name,
        "max_output_tokens": OPENAI_MAX_OUTPUT_TOKENS,
        "temperature": OPENAI_TEMPERATURE,
        "input": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }

    response = _client.responses.create(**params)
    try:
        return _extract_text(response)
    except Exception:
        return None


# Internal helpers -------------------------------------------------------------

def _extract_text(response: object) -> str:
    output = getattr(response, "output", None) or getattr(response, "outputs", None) or []
    texts = []
    for item in output:
        # Handle ResponseOutputMessage items (type='message')
        item_type = getattr(item, "type", None)
        if item_type == "message":
            content = getattr(item, "content", None)
            if content:
                for chunk in content:
                    text = getattr(chunk, "text", None)
                    if text:
                        texts.append(text)
    return "\n".join(texts).strip()

