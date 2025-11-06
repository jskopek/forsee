"""Lightweight utility to save OpenAI requests/responses."""


def _serialize_response(response: object) -> dict:
    """Convert OpenAI response object to a JSON-serializable dict."""
    # Try model_dump() for Pydantic models
    if hasattr(response, "model_dump"):
        return response.model_dump()
    # Try dict() conversion
    if hasattr(response, "__dict__"):
        result = {}
        for key, value in response.__dict__.items():
            if hasattr(value, "model_dump"):
                result[key] = value.model_dump()
            elif hasattr(value, "__dict__"):
                result[key] = _serialize_response(value)
            elif isinstance(value, (list, tuple)):
                result[key] = [
                    _serialize_response(item) if hasattr(item, "__dict__") or hasattr(item, "model_dump") else item
                    for item in value
                ]
            else:
                result[key] = value
        return result
    # Fallback: try to convert to string representation
    return {"_raw": str(response)}


def save_openai_request(request_data: dict, response_data: dict) -> None:
    """
    Save OpenAI request/response to database.
    
    This function is designed to be lightweight and never raise exceptions.
    Failures are silently ignored to avoid breaking the main flow.
    """
    try:
        from .models import OpenAIRequest
        OpenAIRequest.objects.create(
            request_data=request_data,
            response_data=response_data,
        )
    except Exception:
        # Silently ignore all errors - this is just for analysis
        pass

