import os
import json
import logging
import time
from groq import Groq
from django.conf import settings

logger = logging.getLogger(__name__)

_GROQ_CLIENT = None


def _get_groq_client():
    """Lazily instantiate a single Groq client for session reuse."""
    global _GROQ_CLIENT
    if _GROQ_CLIENT is None:
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError("GROQ_API_KEY not set")
        _GROQ_CLIENT = Groq(api_key=api_key)
        logger.info("Groq client initialized")
    return _GROQ_CLIENT


def stream_suggestions_with_tools(conversation, hint=None, prefix=None):
    """
    Stream suggestions using Groq tool calls.
    Yields each suggestion as soon as the model generates it.

    Args:
        conversation: Conversation model instance
        hint: Optional hint text to guide suggestions
        prefix: Optional prefix that suggestions must start with

    Yields:
        str: Each suggestion as it's generated
    """
    client = _get_groq_client()

    # Build compact prompt (same logic as current implementation)
    MAX_WORDS = 12
    N_SUGGESTIONS = 6
    HISTORY_TURNS = 10

    partner_name = conversation.title or ""
    contact_formality = "casual"

    # Get recent messages
    from .models import Message
    qs = conversation.messages.order_by("-created_at", "-id").values("sender", "body")[:HISTORY_TURNS]
    recent = list(reversed(list(qs)))

    def _role_line(sender: str, body: str) -> str:
        if sender == Message.Sender.CONTACT:
            return f"Partner: {body}".strip()
        else:
            return f"You: {body}".strip()

    transcript_lines = [_role_line(m["sender"], m["body"]) for m in recent if m.get("body")]
    transcript = "\n".join(transcript_lines)

    # System prompt optimized for tool calls
    system_prompt = (
        f"Generate {N_SUGGESTIONS} short reply suggestions by calling push_suggestion exactly {N_SUGGESTIONS} times.\n"
        f"Each suggestion: ≤{MAX_WORDS} words, natural speech, no emojis/quotes.\n"
        "If user_hint exists, prioritize it over conversation content.\n"
        "If user_prefix exists, EVERY suggestion MUST start with a complete English word matching that prefix.\n"
        f"Formality: {contact_formality}. Use the conversation title '{partner_name or 'Conversation'}' sparingly for grounding.\n"
        "Call push_suggestion once per suggestion immediately as you think of it."
    )

    user_payload = {
        "formality": contact_formality,
        "conversation_title": partner_name,
        "transcript": transcript,
    }
    if hint:
        user_payload["user_hint"] = hint.strip()[:160]
    if prefix:
        user_payload["user_prefix"] = prefix.strip()[:40]

    # Define tool
    tools = [{
        "type": "function",
        "function": {
            "name": "push_suggestion",
            "description": "Push a single suggestion to the user immediately",
            "parameters": {
                "type": "object",
                "properties": {
                    "suggestion": {
                        "type": "string",
                        "description": "A short, natural reply suggestion"
                    }
                },
                "required": ["suggestion"]
            }
        }
    }]

    # Stream with tool calls
    logger.info(f"Groq streaming suggestions for conversation {conversation.id} (hint={bool(hint)}, prefix={prefix or 'None'})")

    try:
        start_time = time.time()
        first_token_time = None
        total_tokens = 0

        stream = client.chat.completions.create(
            model=settings.GROQ_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)}
            ],
            tools=tools,
            stream=True,
            temperature=0.3,
            max_tokens=500
        )

        # Parse streaming tool calls
        tool_call_buffer = ""
        suggestion_count = 0

        for chunk in stream:
            # Track first token time
            if first_token_time is None:
                first_token_time = time.time()

            # Count tokens (approximate by character length of streaming content)
            if hasattr(chunk.choices[0].delta, 'tool_calls') and chunk.choices[0].delta.tool_calls:
                if hasattr(chunk.choices[0].delta.tool_calls[0], 'function'):
                    if hasattr(chunk.choices[0].delta.tool_calls[0].function, 'arguments'):
                        total_tokens += len(chunk.choices[0].delta.tool_calls[0].function.arguments) // 4  # Rough token estimate

            delta = chunk.choices[0].delta

            if hasattr(delta, 'tool_calls') and delta.tool_calls:
                tool_call = delta.tool_calls[0]

                if hasattr(tool_call, 'function') and hasattr(tool_call.function, 'arguments'):
                    tool_call_buffer += tool_call.function.arguments

                    # Try to parse complete JSON
                    try:
                        args = json.loads(tool_call_buffer)
                        if 'suggestion' in args:
                            suggestion = args['suggestion'].strip()
                            if suggestion:
                                logger.info(f"Suggestion {suggestion_count}: {suggestion}")
                                yield suggestion
                                suggestion_count += 1
                                tool_call_buffer = ""

                                if suggestion_count >= N_SUGGESTIONS:
                                    break
                    except json.JSONDecodeError:
                        # Not complete yet, keep buffering
                        continue

        end_time = time.time()
        total_time = end_time - start_time
        ttft = first_token_time - start_time if first_token_time else 0
        tokens_per_sec = total_tokens / total_time if total_time > 0 else 0

        logger.info(f"Streaming complete: {suggestion_count} suggestions | {total_time:.2f}s total | TTFT: {ttft:.2f}s | ~{tokens_per_sec:.1f} tokens/sec")
    except Exception as e:
        logger.error(f"Error streaming suggestions: {e}", exc_info=True)
        raise


def stream_hints_with_tools(conversation, exclude_words=None):
    """
    Stream hints using Groq tool calls.
    Yields each hint dict as soon as the model generates it.

    Args:
        conversation: Conversation model instance
        exclude_words: Optional list of words to exclude from hints

    Yields:
        dict: Each hint with 'word' and 'emoji' keys
    """
    client = _get_groq_client()

    N_HINTS = 20
    HISTORY_TURNS = 5

    partner_name = conversation.title or ""
    contact_formality = "casual"

    from .models import Message
    qs = conversation.messages.order_by("-created_at", "-id").values("sender", "body")[:HISTORY_TURNS]
    recent = list(reversed(list(qs)))

    def _role_line(sender: str, body: str) -> str:
        if sender == Message.Sender.CONTACT:
            return f"Partner: {body}".strip()
        else:
            return f"You: {body}".strip()

    transcript_lines = [_role_line(m["sender"], m["body"]) for m in recent if m.get("body")]
    transcript = "\n".join(transcript_lines)

    last_message = recent[-1] if recent else None
    last_message_text = last_message.get("body", "") if last_message else ""

    # Build system prompt with exclusion instructions if needed
    system_prompt = (
        f"Generate {N_HINTS} single-word hints by calling push_hint exactly {N_HINTS} times.\n"
        "Each hint: ONE word (no spaces/hyphens) + ONE emoji.\n"
        "Cover diverse response directions: emotions, actions, topics.\n"
    )

    if exclude_words and len(exclude_words) > 0:
        system_prompt += f"\nIMPORTANT: Do NOT use any of these words: {', '.join(exclude_words)}.\n"
        system_prompt += "Generate completely different words that are not in this exclusion list.\n"

    system_prompt += "Call push_hint immediately as you think of each hint."

    user_payload = {
        "formality": contact_formality,
        "conversation_title": partner_name,
        "transcript": transcript,
        "last_message": last_message_text,
    }

    if exclude_words and len(exclude_words) > 0:
        user_payload["excluded_words"] = exclude_words

    tools = [{
        "type": "function",
        "function": {
            "name": "push_hint",
            "description": "Push a single word hint with emoji immediately",
            "parameters": {
                "type": "object",
                "properties": {
                    "word": {"type": "string", "description": "Single word, lowercase"},
                    "emoji": {"type": "string", "description": "Single emoji character"}
                },
                "required": ["word", "emoji"]
            }
        }
    }]

    logger.info(f"Groq streaming hints for conversation {conversation.id} (excluding {len(exclude_words or [])} words)")

    try:
        start_time = time.time()
        first_token_time = None
        total_tokens = 0

        stream = client.chat.completions.create(
            model=settings.GROQ_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)}
            ],
            tools=tools,
            stream=True,
            temperature=0.7,
            max_tokens=800
        )

        tool_call_buffer = ""
        hint_count = 0
        seen_words = set()

        # Create set of excluded words for fast lookup
        excluded_set = set((exclude_words or []))

        for chunk in stream:
            # Track first token time
            if first_token_time is None:
                first_token_time = time.time()

            # Count tokens (approximate by character length of streaming content)
            if hasattr(chunk.choices[0].delta, 'tool_calls') and chunk.choices[0].delta.tool_calls:
                if hasattr(chunk.choices[0].delta.tool_calls[0], 'function'):
                    if hasattr(chunk.choices[0].delta.tool_calls[0].function, 'arguments'):
                        total_tokens += len(chunk.choices[0].delta.tool_calls[0].function.arguments) // 4  # Rough token estimate

            delta = chunk.choices[0].delta

            if hasattr(delta, 'tool_calls') and delta.tool_calls:
                tool_call = delta.tool_calls[0]

                if hasattr(tool_call, 'function') and hasattr(tool_call.function, 'arguments'):
                    tool_call_buffer += tool_call.function.arguments

                    try:
                        args = json.loads(tool_call_buffer)
                        if 'word' in args and 'emoji' in args:
                            word = args['word'].strip().lower()
                            emoji = args['emoji'].strip()

                            # Skip if word is in exclusion list
                            if word in excluded_set:
                                logger.info(f"Skipping excluded word: {word}")
                                tool_call_buffer = ""
                                continue

                            # Deduplicate
                            if word and emoji and word not in seen_words:
                                seen_words.add(word)
                                logger.info(f"Hint {hint_count}: {word} {emoji}")
                                yield {"word": word, "emoji": emoji}
                                hint_count += 1
                                tool_call_buffer = ""

                                if hint_count >= N_HINTS:
                                    break
                    except json.JSONDecodeError:
                        continue

        end_time = time.time()
        total_time = end_time - start_time
        ttft = first_token_time - start_time if first_token_time else 0
        tokens_per_sec = total_tokens / total_time if total_time > 0 else 0

        logger.info(f"Streaming complete: {hint_count} hints | {total_time:.2f}s total | TTFT: {ttft:.2f}s | ~{tokens_per_sec:.1f} tokens/sec")
    except Exception as e:
        logger.error(f"Error streaming hints: {e}", exc_info=True)
        raise
