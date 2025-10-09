# Eye Tracking Keyboard for ALS Patients

## Purpose

This project provides an assistive communication system for ALS patients who may have lost the ability to speak but retain eye movement control. The system enables real-time conversations through eye tracking input combined with intelligent text prediction and voice synthesis.

## Main Features

### Conversation Management
- Support for multi-speaker conversations (initially two-party conversations)
- Persistent conversation history with speaker identification
- Contextual awareness of conversation participants (relationships, topics, background)

### Real-time Transcription
- Voice recognition for the conversation partner
- Live transcription display in the chat interface
- Automatic speaker attribution

### Eye Tracking Keyboard
- Large-target keyboard interface optimized for native OS eye tracking (primarily iOS)
- Designed for users with limited motor control
- No custom eye tracking SDK - relies on iOS accessibility features
- Extra-large buttons and generous spacing for accurate selection

### Intelligent Autocomplete
- Context-aware sentence prediction
- Suggests complete sentences rather than just words
- Refinement based on partial user input
- Leverages:
  - Full conversation history
  - Participant profiles and relationships
  - Typical conversation topics
  - Real-time context from ongoing discussion

### Text-to-Speech
- Automatic voice synthesis for user's typed messages
- Enables spoken responses for the ALS patient

## Technology Stack

- **Frontend:** Alpine.js + HTMX
- **Backend:** Django (Python)
- **Database:** PostgreSQL (production), SQLite (development)
- **AI:** OpenAI API
- **Real-time:** HTMX polling (initial), WebSockets (future)
- **Platform:** Web application (optimized for iOS/Safari)
- **Eye Tracking:** Native iOS accessibility features (no custom SDK)

## Current Status

Project in initial planning phase.
