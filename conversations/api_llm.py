"""
LLM Proxy API
Streams LLM responses from Groq using Django settings.
"""
from __future__ import annotations

import logging
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

    # Get Pusher client
    pusher = get_pusher_client()
    if not pusher:
        logger.error("No Pusher client available")
        return {"stream_id": data.stream_id, "status": "error"}

    def trigger_event(event_type: str, event_data: dict):
        """Helper to send Pusher events."""
        pusher.trigger(
            f'llm-stream-{data.stream_id}',
            event_type,
            {**event_data, 'stream_id': data.stream_id}
        )

    try:
        # Get Groq config from Django settings
        groq_model = settings.GROQ_MODEL
        groq_api_key = os.getenv('GROQ_API_KEY')

        logger.info(f"[LLM Proxy] Stream {data.stream_id} using Groq/{groq_model}")

        # Create Groq client
        client = Groq(api_key=groq_api_key)

        # Convert tools format
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

        # Start streaming from Groq
        stream = client.chat.completions.create(
            model=groq_model,
            messages=[{"role": "user", "content": data.prompt}],
            tools=tools,
            temperature=data.temperature,
            max_tokens=data.max_tokens,
            stream=True
        )

        current_tool_call = None
        token_count = 0

        # Stream chunks to client via Pusher
        for chunk in stream:
            delta = chunk.choices[0].delta

            # Stream content tokens
            if delta.content:
                trigger_event('token', {'token': delta.content})
                token_count += 1

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
                            trigger_event('tool_call', {
                                'name': current_tool_call['name'],
                                'arguments': args
                            })
                            current_tool_call = None
                        except json.JSONDecodeError:
                            pass  # Wait for more chunks

        # Send completion event
        trigger_event('complete', {'tokens': token_count})
        logger.info(f"[LLM Proxy] Stream complete: {token_count} tokens")

    except Exception as e:
        logger.error(f"[LLM Proxy] Error: {e}", exc_info=True)
        trigger_event('error', {'message': str(e)})

    return {"stream_id": data.stream_id, "status": "streaming"}
