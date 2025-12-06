"""
LLM Proxy API
Streams LLM responses from Groq using Django settings.
"""
from __future__ import annotations

import logging
import shellviz
import json
import os
from typing import Optional
from uuid import UUID

from ninja import Router
from pydantic import BaseModel, Field
from groq import Groq
from django.conf import settings

from .signals import get_pusher_client

logger = logging.getLogger(__name__)

llm_router = Router(tags=["llm"])


# ============================================================================
# REQUEST/RESPONSE SCHEMAS
# ============================================================================

class LLMTool(BaseModel):
    name: str
    description: str
    parameters: dict


class LLMStreamRequest(BaseModel):
    """Client sends only prompt and tools - server decides provider/model."""
    prompt: str = Field(..., description="The prompt to send to the LLM")
    tools: Optional[list[LLMTool]] = Field(default=None, description="Optional tool definitions")
    temperature: Optional[float] = Field(default=0.7, description="Temperature parameter (0-1)")
    max_tokens: Optional[int] = Field(default=500, description="Maximum tokens to generate")
    stream_id: str = Field(..., description="Client-generated UUID for tracking streaming session")
    conversation_id: Optional[UUID] = Field(default=None, description="Optional conversation context")


class StreamingStatusResponse(BaseModel):
    stream_id: str
    status: str




# ============================================================================
# API ENDPOINT
# ============================================================================

@llm_router.post("/stream", response=StreamingStatusResponse)
def stream_llm(request, data: LLMStreamRequest):
    """
    LLM proxy endpoint - streams from Groq using settings from Django config.

    Events sent via Pusher:
    - 'token': {stream_id, token} - Each content token
    - 'tool_call': {stream_id, name, arguments} - Complete tool calls
    - 'complete': {stream_id, tokens} - Streaming finished
    - 'error': {stream_id, message} - Error occurred
    """

    # shellviz.clear()
    shellviz.log("Starting LLM stream", data.stream_id)
    # Get Pusher client
    pusher = get_pusher_client()
    if not pusher:
        logger.error("No Pusher client available")
        return {"stream_id": data.stream_id, "status": "error"}

    def trigger_event(event_type: str, event_data: dict):
        """Helper to send Pusher events."""
        try:
            pusher.trigger(
                f'llm-stream-{data.stream_id}',
                event_type,
                {**event_data, 'stream_id': data.stream_id}
            )
        except Exception as exc:  # noqa: BLE001
            logger.error(f"[LLM Proxy] Failed to send {event_type}: {exc}", exc_info=True)

    def emit_error(message: str, exc: Exception | None = None):
        if exc:
            logger.error(f"[LLM Proxy] {message}: {exc}", exc_info=True)
        else:
            logger.error(f"[LLM Proxy] {message}")
        trigger_event('error', {'message': message})
        return {"stream_id": data.stream_id, "status": "error"}

    groq_model = getattr(settings, "GROQ_MODEL", None)
    if not groq_model:
        return emit_error("GROQ model not configured")

    groq_api_key = os.getenv('GROQ_API_KEY')
    if not groq_api_key:
        return emit_error("GROQ_API_KEY not set")


    try:
        client = Groq(api_key=groq_api_key)
    except Exception as exc:  # noqa: BLE001
        return emit_error("Failed to initialize Groq client", exc)

    tools = None
    if data.tools:
        tools = [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters
                }
            }
            for tool in data.tools
        ]

        for tool in data.tools:
            shellviz.table([''], id=f"tool-{tool.name}", append=False)

    shellviz.log(data.prompt, id="prompt")
    try:
        stream = client.chat.completions.create(
            model=groq_model,
            messages=[{"role": "user", "content": data.prompt}],
            tools=tools,
            temperature=data.temperature,
            max_tokens=data.max_tokens,
            stream=True
        )
    except Exception as exc:  # noqa: BLE001
        return emit_error("Failed to start Groq stream", exc)

    current_tool_call = None
    token_count = 0
    content_parts: list[str] = []

    try:
        # Stream chunks to client via Pusher
        for chunk in stream:
            delta = chunk.choices[0].delta

            # Stream content tokens
            if delta.content:
                trigger_event('token', {'token': delta.content})
                token_count += 1
                content_parts.append(delta.content)

            # Handle tool calls
            if delta.tool_calls:
                for tool_call in delta.tool_calls:
                    if tool_call.function.name:
                        current_tool_call = {
                            'name': tool_call.function.name,
                            'arguments': ''
                        }

                    if tool_call.function.arguments:
                        current_tool_call['arguments'] += tool_call.function.arguments

                        # Try to parse complete JSON
                        try:
                            args = json.loads(current_tool_call['arguments'])
                            shellviz.table(list(args.values()), id=f"tool-{current_tool_call['name']}", append=True)
                            logger.info(
                                "[LLM Proxy] Tool call received | stream_id=%s | tool=%s | args=%s",
                                data.stream_id,
                                current_tool_call['name'],
                                args,
                            )
                            trigger_event('tool_call', {
                                'name': current_tool_call['name'],
                                'arguments': args
                            })
                            current_tool_call = None
                        except json.JSONDecodeError:
                            pass  # Wait for more chunks
    except Exception as exc:  # noqa: BLE001
        return emit_error("Streaming interrupted", exc)

    trigger_event('complete', {'tokens': token_count})
    full_response = "".join(content_parts)
    logger.info(
        "[LLM Proxy] Stream complete | stream_id=%s | tokens=%s | response=%s",
        data.stream_id,
        token_count,
        full_response,
    )

    return {"stream_id": data.stream_id, "status": "streaming"}
