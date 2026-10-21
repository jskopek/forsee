from __future__ import annotations

import io
import logging
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List

from django.conf import settings

from .models import Message
from .utils_prompt_groq import _get_groq_client

logger = logging.getLogger(__name__)

# Defaults can be overridden via Django settings / environment
DEFAULT_AUDIO_MODEL = getattr(settings, "GROQ_AUDIO_MODEL", "whisper-large-v3")
SESSION_TTL_SECONDS = 180
TRANSCRIBE_INTERVAL_SECONDS = 2.5
MAX_AUDIO_BYTES = 6 * 1024 * 1024  # 6 MB safety cap


@dataclass
class VoiceStreamSession:
    """In-memory session state for a streaming microphone capture."""

    stream_id: uuid.UUID
    conversation_id: uuid.UUID
    created_at: float
    last_chunk_at: float
    buffer: bytearray = field(default_factory=bytearray)
    emitted_sentences: List[str] = field(default_factory=list)
    last_text: str = ""
    last_transcribed_at: float = 0.0
    lock: threading.Lock = field(default_factory=threading.Lock)


# In-memory session registry (development only)
VOICE_STREAMS: Dict[str, VoiceStreamSession] = {}


def cleanup_expired_sessions() -> None:
    """Drop any stale sessions to bound memory usage."""
    now = time.time()
    for stream_id, session in list(VOICE_STREAMS.items()):
        if now - session.last_chunk_at > SESSION_TTL_SECONDS:
            VOICE_STREAMS.pop(stream_id, None)


def create_session(conversation_id: uuid.UUID) -> VoiceStreamSession:
    """Create and store a new streaming session."""
    cleanup_expired_sessions()
    stream_id = uuid.uuid4()
    session = VoiceStreamSession(
        stream_id=stream_id,
        conversation_id=conversation_id,
        created_at=time.time(),
        last_chunk_at=time.time(),
    )
    VOICE_STREAMS[str(stream_id)] = session
    logger.info("Voice stream session created | stream_id=%s | conversation=%s", stream_id, conversation_id)
    return session


def get_session(stream_id: uuid.UUID, conversation_id: uuid.UUID) -> VoiceStreamSession | None:
    """Fetch a session if it exists and matches the conversation."""
    session = VOICE_STREAMS.get(str(stream_id))
    if not session:
        return None
    if session.conversation_id != conversation_id:
        logger.warning(
            "Voice stream conversation mismatch | stream_id=%s | expected=%s | got=%s",
            stream_id,
            session.conversation_id,
            conversation_id,
        )
        return None
    return session


def append_chunk(session: VoiceStreamSession, chunk: bytes) -> None:
    """Append raw audio bytes to the session buffer with bounds checking."""
    if not chunk:
        raise ValueError("Audio chunk is empty")

    with session.lock:
        if len(session.buffer) + len(chunk) > MAX_AUDIO_BYTES:
            raise ValueError("Audio stream too large; please stop and retry")
        session.buffer.extend(chunk)
        session.last_chunk_at = time.time()


def _extract_completed_sentences(text: str) -> list[str]:
    """Split transcript into completed sentences (ending with punctuation)."""
    cleaned = text.strip()
    if not cleaned:
        return []

    parts = re.split(r'(?<=[.!?])\s+', cleaned)
    sentences: list[str] = []
    for part in parts:
        candidate = part.strip()
        if candidate and candidate[-1] in {'.', '!', '?'}:
            sentences.append(candidate)
    return sentences


def _diff_sentences(session: VoiceStreamSession, transcript: str, is_final: bool) -> list[str]:
    """
    Determine which sentences are newly completed compared to prior transcript.
    """
    completed = _extract_completed_sentences(transcript)
    emitted_set = set(session.emitted_sentences)

    new_sentences: list[str] = []
    for sentence in completed:
        if sentence not in emitted_set:
            new_sentences.append(sentence)
            emitted_set.add(sentence)

    # If final chunk, also emit any trailing fragment after the last punctuation
    if is_final:
        punct_positions = [transcript.rfind('.'), transcript.rfind('!'), transcript.rfind('?')]
        last_punct = max([p for p in punct_positions if p >= 0], default=-1)
        trailing = transcript[last_punct + 1:].strip() if last_punct >= 0 else transcript.strip()
        if trailing and trailing not in emitted_set and trailing not in new_sentences:
            new_sentences.append(trailing)
            emitted_set.add(trailing)

    session.emitted_sentences = list(emitted_set)
    session.last_text = transcript
    session.last_transcribed_at = time.time()
    return new_sentences


def _transcribe_audio_bytes(audio_bytes: bytes) -> str:
    """Send audio to Groq transcription endpoint and return text."""
    client = _get_groq_client()
    audio_file = io.BytesIO(audio_bytes)
    # Groq SDK follows the OpenAI-compatible signature
    response = client.audio.transcriptions.create(
        file=("audio.webm", audio_file, "audio/webm"),
        model=DEFAULT_AUDIO_MODEL,
        response_format="json",
        temperature=0,
    )

    # response may be an object or dict-like
    text = getattr(response, "text", None)
    if text:
        return text
    if isinstance(response, dict):
        return response.get("text", "")
    return ""


def maybe_transcribe(session: VoiceStreamSession, conversation, is_final: bool = False) -> list[str]:
    """
    Transcribe buffered audio if enough time has passed or if this is the final chunk.

    Returns:
        list[str]: sentences that were persisted as messages.
    """
    now = time.time()
    if not is_final and (now - session.last_transcribed_at) < TRANSCRIBE_INTERVAL_SECONDS:
        return []

    with session.lock:
        audio_bytes = bytes(session.buffer)

    if not audio_bytes:
        return []

    try:
        transcript = _transcribe_audio_bytes(audio_bytes)
    except Exception as exc:  # noqa: BLE001
        logger.error("Voice transcription failed: %s", exc, exc_info=True)
        return []

    new_sentences = _diff_sentences(session, transcript, is_final)
    saved: list[str] = []
    for sentence in new_sentences:
        if not sentence.strip():
            continue
        # Voice-captured messages should appear as coming from the contact, not the user
        Message.objects.create(
            conversation=conversation,
            sender=Message.Sender.CONTACT,
            body=sentence.strip(),
        )
        saved.append(sentence.strip())
        logger.info(
            "Voice sentence saved | stream_id=%s | conversation=%s | sentence=%s",
            session.stream_id,
            conversation.id,
            sentence,
        )

    if is_final:
        cleanup_expired_sessions()

    return saved


def close_session(stream_id: uuid.UUID) -> None:
    """Remove a session after completion."""
    VOICE_STREAMS.pop(str(stream_id), None)
