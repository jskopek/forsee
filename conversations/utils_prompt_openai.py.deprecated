import os
from django.conf import settings
from openai import OpenAI
from pydantic import BaseModel

OPENAI_TEMPERATURE = 0.7
OPENAI_MAX_OUTPUT_TOKENS = 400
_OPENAI_CLIENT: OpenAI | None = None


def _get_openai_client() -> OpenAI:
    """
    Lazily instantiate a single OpenAI client so every request reuses the same HTTP session.
    """
    global _OPENAI_CLIENT
    if _OPENAI_CLIENT is None:
        if not os.getenv("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY is not set.")
        _OPENAI_CLIENT = OpenAI()
    return _OPENAI_CLIENT


def prompt_openai(
    system_prompt: str,
    user_prompt: str,
    temperature: float = OPENAI_TEMPERATURE,
    max_output_tokens: int = OPENAI_MAX_OUTPUT_TOKENS,
    pydantic_model: type[BaseModel] | None = None,
    model_name: str | None = None,
) -> str | BaseModel | None:
    """
    Request output from OpenAI using the Responses API.

    If `pydantic_model` is provided, uses `responses.parse` with `text_format` (server-side
    Pydantic parsing) and returns a Pydantic model instance.
    Otherwise, uses `responses.create` and returns raw text.
    """
    if model_name is None:
        model_name = settings.OPENAI_RESPONSES_MODEL

    client = _get_openai_client()

    # Common message shape
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    try:
        if pydantic_model:
            if BaseModel is None:
                raise RuntimeError("Pydantic is required for pydantic_model parameter")
            # ✅ Pydantic-enforced path (returns model instance)
            resp = client.responses.parse(
                model=model_name,
                input=messages,
                text_format=pydantic_model,
                temperature=temperature,
                max_output_tokens=max_output_tokens,
            )
            parsed = getattr(resp, "output_parsed", None)
            if parsed is None:
                raise RuntimeError("responses.parse returned no output_parsed")
            _log_openai_request_safe(
                request={
                    "endpoint": "responses.parse",
                    "model": model_name,
                    "temperature": temperature,
                    "max_output_tokens": max_output_tokens,
                    "text_format": pydantic_model.__name__,
                    "input": messages,
                },
                response=resp,
            )
            return parsed
        else:
            # ✅ Plain-text path
            resp = client.responses.create(
                model=model_name,
                input=messages,
                temperature=temperature,
                max_output_tokens=max_output_tokens,
            )
            text = getattr(resp, "output_text", "") or ""
            _log_openai_request_safe(
                request={
                    "endpoint": "responses.create",
                    "model": model_name,
                    "temperature": temperature,
                    "max_output_tokens": max_output_tokens,
                    "input": messages,
                },
                response=resp,
            )
            return text.strip() or None

    except Exception as e:
        # Centralized error handling
        import logging

        logging.getLogger(__name__).error(f"OpenAI error: {type(e).__name__}: {e}")
        return None


def _log_openai_request_safe(request: dict, response) -> None:
    """Best-effort logging without breaking the call."""
    if not getattr(settings, "OPENAI_LOG_REQUESTS", False):
        return
    try:
        from openai_analysis.utils import save_openai_request, _serialize_response
        save_openai_request(request.copy(), _serialize_response(response))
    except Exception:
        pass
