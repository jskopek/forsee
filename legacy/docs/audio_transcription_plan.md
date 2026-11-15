# Audio Capture → Server Transcription Plan

## Goals
- Let `keyboard-ui` capture microphone audio, stream it to the Django backend, and create conversation messages from the resulting transcript.
- Detect speaker pauses/stop events so that each spoken segment becomes one `Message` and triggers new hints/suggestions automatically.
- Offload speech-to-text to a third-party provider (Groq preferred) while keeping the server responsible for transcription orchestration, conversation writes, and retries.

## High-Level Architecture
1. **Keyboard UI**
   - Add an “Audio Capture” control (button / dwell target) that requests mic access, records audio, and streams chunks to the server via WebSocket or WebRTC data channel (prefer WebSocket for simplicity).
   - Use `MediaRecorder` (Web API) in `audio/webm;codecs=opus` format, emit chunks every ~500ms, and detect end-of-speech locally via VAD or silence threshold to send `stop` events.
2. **Server**
   - Add a Channels consumer (`/ws/conversations/<id>/audio`) to receive audio chunks, buffer them per session, and forward them to transcription worker (async task or streaming client).
   - Use Groq’s speech-to-text API (Whisper derivative) via streaming or chunked uploads; server controls API keys and handles retries, partial transcripts, and finalization.
   - When a transcript segment is finalized (speaker finished), create a `Message` (sender=`contact`) and fire realtime events (message_added, hints/suggestions refresh).
3. **State Machine**
   - Each audio stream has phases: `recording`, `transcribing`, `finalized`. Server tracks these using `AudioStream` model or in-memory map to know when to close sessions, flush buffers, and clean up.

## Detailed Components

### 1. Keyboard UI Changes
- Add `useAudioRecorder` hook:
  - Requests `navigator.mediaDevices.getUserMedia({ audio: true })`.
  - Instantiates `MediaRecorder` with timeslice (e.g., 750ms) and dispatches `Blob` chunks to an open WebSocket.
  - Maintains client-side VAD (WebAudio) to detect silence; after configurable pause (e.g., 1.5s) send `STOP` control frame to server.
  - Handles UI states: `idle`, `listening`, `sending`, `error` and shows waveform / timer.
- Reuse existing realtime client for WebSockets or add dedicated `AudioStreamClient` that connects to `/ws/conversations/<id>/audio?token=...`.
- On final transcript event from server, show toast + update UI (maybe display recognized text for confirmation, highlight in conversation feed).

### 2. WebSocket Protocol
- Messages exchanged as JSON frames:
  - Client → Server
    - `{type: 'start', conversation_id, sample_rate, mime_type}`
    - `{type: 'chunk', data: <base64 audio chunk>, seq}`
    - `{type: 'stop'}` (speaker finished or user canceled)
    - `{type: 'cancel'}` (discard transcript)
  - Server → Client
    - `{type: 'ack', seq}`
    - `{type: 'partial_transcript', text, confidence}` (optional)
    - `{type: 'final_transcript', text, message_id}`
    - `{type: 'error', message}`
- Keep payloads small; compress base64? For MVP base64 is acceptable; later optimize via binary WebSocket frames.

### 3. Server Processing Flow
1. **Consumer (`AudioStreamConsumer`)**
   - Authenticates session, ensures conversation access.
   - On `start`, allocate stream context (UUID, buffer list, metadata) stored in Redis or in-memory map keyed by channel name.
   - On `chunk`, append to context buffer and optionally push to transcription worker queue.
   - On `stop`, mark stream closed, flush buffers, and trigger transcription finalization.
2. **Transcription Worker**
   - Option A: synchronous – consumer posts aggregated audio to Groq when `stop` arrives (simple but delays partial feedback).
   - Option B: streaming – start Groq transcription when `start` arrives, send chunks as they arrive for near-real-time captions.
   - API call: `client.audio.transcriptions.create(model=settings.GROQ_STT_MODEL, file=<chunk bytes>, response_format='verbose_json')` or streaming equivalent.
3. **Message Creation / Notifications**
   - Once Groq returns final text, wrap in `Message` (sender=contact or user depending on context) and fire existing signals (which will go through Django Channels once Pusher replaced).
   - Trigger plugin refresh hooks (suggestions/hints) by calling their registered refresh endpoints or via realtime events (`conversation.<id>` group event `transcription_ready`).

### 4. Silence / End-of-Speech Detection
- Primary detection done on client for better UX and quick UI feedback.
- Server double-check: if no `chunk` received for X seconds, auto-finalize to avoid dangling sessions.
- Keep `max_duration` (e.g., 2 minutes) guardrail; after hitting max, server auto-sends `stop` to transcription.

### 5. Configuration & Settings
- Feature flag `AUDIO_TRANSCRIPTION_ENABLED` in both client (env var) and server.
- Allow per-conversation or per-user toggles for microphone usage.
- Define recording quality defaults (sample rate 16k, opus/PCM) and allow advanced settings later.

## Implementation Phases
1. **Backend Foundations**
   - Add Channels consumer, stream context management, and Groq transcription client helper; write unit tests for chunk assembly and transcript-to-message flow.
2. **Frontend Capture**
   - Build recorder hook + UI controls, connect to new WebSocket endpoint, and handle lifecycle events.
3. **Integration**
   - Wire final transcripts into conversation feed, trigger suggestions/hints refresh, and display statuses.
4. **Polish & Monitoring**
   - Analytics on transcription latency, failure rates, and false silence detection.
   - UX touches: waveform visualization, caption preview, cancel/redo controls.

## Future Enhancements
- Support dual-speaker attribution (auto detect whether audio belongs to user vs. contact).
- Allow optional local/offline transcription by swapping out Groq adapter.
- Provide downloadable audio clips attached to each message for auditing.

This plan keeps transcription logic centralized on the server while giving `keyboard-ui` a clean streaming API and clear UX flow for capturing spoken replies.
