# AI Agent Instructions for Eye Tracking Keyboard Project

## Project Overview
This is an assistive communication system for ALS patients combining eye tracking input with AI-enhanced text prediction and voice synthesis. The system enables real-time conversations through an accessible interface designed for users with limited motor control.

## Architecture

### Core Components
- **Django Backend** (`app/`, `conversations/`, etc.)
  - Handles user management, conversations, contacts
  - Uses Django RQ for async jobs (AI response generation)
  - PostgreSQL in production, SQLite in development
  
- **React Frontend** (`keyboard-ui/`)
  - Eye tracking optimized keyboard interface
  - Large target buttons for accurate selection
  - Uses native iOS accessibility features

### Key Data Models
- `conversations/models.py`:
  ```python
  class Conversation:  # Links user <-> contact discussions
  class Message:      # Individual messages with sender type (user/contact/system)
  ```

### Integration Points
1. OpenAI API (via `OPENAI_RESPONSES_MODEL` setting)
2. Redis (for Django RQ background tasks)
3. Native iOS eye tracking APIs

## Development Workflow

### Environment Setup
1. Python environment:
   ```bash
   python -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```

2. React UI:
   ```bash
   cd keyboard-ui
   npm install
   npm start  # Dev server on localhost:3000
   ```

3. Environment variables (`.env`):
   ```
   SECRET_KEY=...
   OPENAI_RESPONSES_MODEL=gpt-5-nano
   REDIS_URL=redis://127.0.0.1:6379/0
   ```

### Key Patterns
1. **AI Response Generation**
   - Always use background tasks for AI operations
   - Response jobs tracked via `last_response_job_id` field
   - See `conversations/views.py` for examples

2. **Profile Data Snapshots**
   - Conversations store user/contact profile snapshots
   - Use JSONField with normalized interests
   - Example in `ConversationCreateView`

3. **View Organization**
   - Main views extend `LoginRequiredMixin`
   - HTMX integration via `is_htmx()` utility
   - Partial templates in `partials/` subdirectories

4. **Testing**
   - Mock data generators in `services/mock_*.py`
   - Use `UserPassesTestMixin` for authorization checks

## Common Tasks
- Generate mock conversations: POST to `/contacts/<id>/generate/`
- Quick start conversation: POST to `/contacts/<id>/quick-start/`
- Get reply suggestions: GET/POST `/conversations/<id>/suggestions/`

## Performance Considerations
- Use Django's `select_related` and `Prefetch` for efficient queries
- Index fields used in common filters (see model Meta classes)
- Cache conversation snapshots to avoid repeated profile lookups