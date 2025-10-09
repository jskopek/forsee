# Development Roadmap

## Phase 1: Planning & Architecture

### 1.1 Technical Stack Selection
- [x] **Frontend:** Alpine.js (on-page interactivity) + HTMX (server interactions)
- [x] **Backend:** Django (Python)
- [x] **Real-time:** WebSockets (future), HTMX polling (initial implementation)
- [x] **Database:** PostgreSQL (production), SQLite (local development)
- [x] **AI Services:** OpenAI API
- [x] **Deployment:** Web application

### 1.2 Eye Tracking Approach
- [x] **Strategy:** Rely on native OS eye tracking (primarily iOS)
- [x] **No custom SDK integration required**
- [ ] Design UI with large, easy-to-select targets for accessibility
- [ ] Test with iOS eye tracking features (Settings > Accessibility > Eye Tracking)
- [ ] Ensure touch targets meet accessibility guidelines (minimum 44x44 points)

### 1.3 Database Schema Design
- [ ] Design `conversations` table (id, title, created_at, updated_at)
- [ ] Design `participants` table (id, name, relationship, notes, conversation_topics)
- [ ] Design `messages` table (id, conversation_id, speaker_id, content, timestamp, is_user_message)
- [ ] Design `conversation_participants` junction table
- [ ] Design `user_preferences` table for settings and configurations
- [ ] Create schema diagrams and documentation

## Phase 2: Core Infrastructure

### 2.1 Project Setup
- [ ] Initialize Django project
- [ ] Create requirements.txt with dependencies (Django, django-channels, openai, etc.)
- [ ] Set up virtual environment
- [ ] Configure Django settings for SQLite (dev) and PostgreSQL (prod)
- [ ] Set up static files configuration for Alpine.js and HTMX
- [ ] Configure linting (flake8, black) and code formatting
- [ ] Create initial Django apps structure (conversations, participants, etc.)
- [ ] Set up environment variables (.env file)

### 2.2 Database Implementation
- [ ] Configure Django database settings (SQLite + PostgreSQL)
- [ ] Create Django models for conversations, participants, messages
- [ ] Define model relationships and foreign keys
- [ ] Add model validators and custom methods
- [ ] Create initial migrations with `python manage.py makemigrations`
- [ ] Run migrations with `python manage.py migrate`
- [ ] Create Django admin registrations for models
- [ ] Add seed data using fixtures or management commands

### 2.3 Basic UI Framework
- [ ] Create base Django template with Alpine.js and HTMX
- [ ] Set up Django URL routing
- [ ] Add Tailwind CSS or similar for styling
- [ ] Create reusable Django template components/partials
- [ ] Set up Alpine.js for client-side state management
- [ ] Configure HTMX for dynamic content loading
- [ ] Create base layout template with navigation

## Phase 3: Conversation Management

### 3.1 Conversation CRUD Operations
- [ ] Create Django views for conversation list
- [ ] Create Django view for conversation detail
- [ ] Create Django view/form for new conversation
- [ ] Create Django view for conversation deletion
- [ ] Add HTMX endpoints for conversation loading
- [ ] Implement search/filter with Django QuerySets
- [ ] Create templates for conversation CRUD operations

### 3.2 Participant Management
- [ ] Create participant profile interface
- [ ] Implement add/edit participant details
- [ ] Build participant selection for conversations
- [ ] Add fields for relationship, job, common topics
- [ ] Create participant history view

### 3.3 Message Display
- [ ] Design chat interface layout
- [ ] Implement message list component
- [ ] Add speaker identification/avatars
- [ ] Show timestamps
- [ ] Auto-scroll to latest messages
- [ ] Style user vs. participant messages differently

## Phase 4: Eye Tracking Keyboard

### 4.1 Keyboard UI Design
- [ ] Design keyboard layout (QWERTY, optimized, or adaptive)
- [ ] Set large key sizes for easy selection (minimum 44x44 points, ideally larger)
- [ ] Plan special keys (space, backspace, submit, etc.) with extra-large targets
- [ ] Design autocomplete suggestion area with very large, easy-to-select buttons
- [ ] Create prominent visual feedback for hover/focus states
- [ ] Add generous padding/spacing between all interactive elements

### 4.2 Accessibility-First Design (No Custom Eye Tracking)
- [ ] Design keyboard keys with large touch targets (minimum 44x44 points)
- [ ] Add generous spacing between keys for accurate selection
- [ ] Implement clear visual feedback on hover/focus
- [ ] Test with iOS native eye tracking and dwell control
- [ ] Ensure compatibility with other assistive technologies
- [ ] Add clear selection confirmation animations

### 4.3 Input Management
- [ ] Build text input buffer
- [ ] Implement character entry from keyboard
- [ ] Add backspace/delete functionality
- [ ] Create word and sentence boundaries detection
- [ ] Implement submit/send message action
- [ ] Add clear/reset input functionality

### 4.4 Accessibility Features
- [ ] Ensure full mouse/trackpad compatibility
- [ ] Implement keyboard navigation support
- [ ] Follow WCAG accessibility guidelines
- [ ] Test with various assistive technologies
- [ ] Add high contrast mode support
- [ ] Ensure focus indicators are clearly visible

## Phase 5: Speech Recognition (Partner Input)

### 5.1 Speech-to-Text Integration
- [ ] Implement Web Speech API for client-side STT
- [ ] Add JavaScript for microphone access and permissions
- [ ] Create HTMX endpoint to receive transcription results
- [ ] Add audio input selection UI (multiple microphones)
- [ ] Handle continuous/streaming recognition with Alpine.js
- [ ] Send transcribed text to Django backend via HTMX

### 5.2 Real-time Transcription
- [ ] Display interim/partial transcription results
- [ ] Finalize and commit completed phrases
- [ ] Add transcription to conversation as partner messages
- [ ] Implement speaker diarization if multi-speaker
- [ ] Handle transcription errors and corrections

### 5.3 Audio Controls
- [ ] Add start/stop recording button
- [ ] Show recording indicator
- [ ] Implement pause/resume functionality
- [ ] Add audio level visualization
- [ ] Create mute/unmute controls

## Phase 6: Text-to-Speech (User Output)

### 6.1 TTS Integration
- [ ] Implement Web Speech API for client-side TTS
- [ ] Create JavaScript module for text-to-speech
- [ ] Implement voice selection UI (male/female, accent, tone)
- [ ] Configure speech rate and pitch controls
- [ ] Handle long text splitting for natural pauses
- [ ] Trigger TTS on message submission via Alpine.js

### 6.2 Message Playback
- [ ] Automatically speak messages when user submits
- [ ] Add manual replay option for sent messages
- [ ] Show speaking indicator
- [ ] Implement stop/cancel speech
- [ ] Queue multiple messages if needed

### 6.3 Voice Customization
- [ ] Create voice settings UI
- [ ] Allow voice preview/testing
- [ ] Save user voice preferences
- [ ] Add volume control
- [ ] Implement speed adjustment

## Phase 7: Intelligent Autocomplete System

### 7.1 Autocomplete Architecture
- [ ] Design autocomplete data flow
- [ ] Determine suggestion refresh triggers
- [ ] Plan suggestion ranking algorithm
- [ ] Design suggestion display UI (list, tiles, etc.)
- [ ] Determine number of suggestions to show (3-5)

### 7.2 Context Building
- [ ] Extract conversation history as context
- [ ] Include participant profile information
- [ ] Add recent messages for immediate context
- [ ] Build context summary for ML model
- [ ] Implement context window size limits

### 7.3 ML Model Integration
- [ ] Set up OpenAI API client in Django
- [ ] Store API key securely in environment variables
- [ ] Create Django service/utility for OpenAI calls
- [ ] Design prompt engineering for sentence completion
- [ ] Implement context injection into prompts
- [ ] Handle API rate limits and errors with retries
- [ ] Cache OpenAI responses to minimize API calls

### 7.4 Suggestion Generation
- [ ] Create Django endpoint for initial suggestions
- [ ] Pass conversation context to OpenAI API
- [ ] Generate 3-5 complete sentence predictions
- [ ] Implement ranking logic for suggestions
- [ ] Cache suggestions in Django cache or Redis
- [ ] Return suggestions via HTMX response
- [ ] Display suggestions in Alpine.js component

### 7.5 Real-time Refinement
- [ ] Create Django endpoint for suggestion updates
- [ ] Implement HTMX polling for suggestion refresh
- [ ] Filter suggestions client-side with Alpine.js based on input
- [ ] Re-generate suggestions at word boundaries via HTMX
- [ ] Implement debouncing in Alpine.js (500ms)
- [ ] Show "loading" indicator during HTMX requests
- [ ] Later: migrate to WebSockets for real-time updates

### 7.6 Suggestion Selection
- [ ] Make suggestions selectable via eye tracking
- [ ] Insert selected suggestion into input
- [ ] Allow editing after selection
- [ ] Track suggestion usage for learning
- [ ] Implement suggestion feedback mechanism

### 7.7 Learning & Personalization
- [ ] Track which suggestions are accepted
- [ ] Store user's common phrases
- [ ] Build personal vocabulary database
- [ ] Adapt suggestions to user's style over time
- [ ] Implement privacy-preserving learning

## Phase 8: Polish & Optimization

### 8.1 Performance Optimization
- [ ] Optimize database queries
- [ ] Implement lazy loading for long conversations
- [ ] Cache frequently used data
- [ ] Minimize ML API calls
- [ ] Optimize rendering performance

### 8.2 Error Handling
- [ ] Add error boundaries/handling
- [ ] Implement graceful degradation
- [ ] Add user-friendly error messages
- [ ] Log errors for debugging
- [ ] Handle offline scenarios

### 8.3 Settings & Preferences
- [ ] Create settings panel
- [ ] Add theme/appearance options
- [ ] Configure eye tracking sensitivity
- [ ] Set TTS voice and speed
- [ ] Configure autocomplete behavior
- [ ] Add privacy/data settings

### 8.4 Data Management
- [ ] Implement conversation export
- [ ] Add conversation backup functionality
- [ ] Create data import feature
- [ ] Add conversation archiving
- [ ] Implement data deletion

## Phase 9: Testing & Accessibility

### 9.1 Accessibility Testing
- [ ] Test with iOS native eye tracking (Settings > Accessibility)
- [ ] Test with screen readers
- [ ] Verify keyboard navigation
- [ ] Check color contrast ratios (WCAG AAA if possible)
- [ ] Test with Switch Control and other iOS assistive features
- [ ] Verify WCAG 2.1 Level AA compliance minimum
- [ ] Test target sizes meet or exceed 44x44 point minimum

### 9.2 User Testing
- [ ] Conduct usability testing
- [ ] Test with ALS patients or advocates if possible
- [ ] Gather feedback on keyboard layout
- [ ] Evaluate autocomplete effectiveness
- [ ] Test conversation flow

### 9.3 Browser/Platform Testing
- [ ] Primary: Test on iOS Safari with native eye tracking
- [ ] Test on iPad with various screen sizes
- [ ] Test on macOS Safari (secondary platform)
- [ ] Verify mobile browser compatibility (Chrome, Firefox on iOS)
- [ ] Test with different screen sizes and orientations
- [ ] Check performance on older iOS devices
- [ ] Ensure responsive design works across all breakpoints

## Phase 10: Documentation & Deployment

### 10.1 User Documentation
- [ ] Write user guide
- [ ] Create setup instructions
- [ ] Document eye tracking calibration
- [ ] Explain feature usage
- [ ] Create troubleshooting guide

### 10.2 Technical Documentation
- [ ] Document codebase architecture
- [ ] Add API documentation
- [ ] Create contribution guidelines
- [ ] Document deployment process
- [ ] Add development setup guide

### 10.3 Deployment
- [ ] Create production build process
- [ ] Set up distribution method (installer, app store, etc.)
- [ ] Configure auto-updates if applicable
- [ ] Create deployment pipeline
- [ ] Plan release strategy

---

## Current Status: Phase 1 - Planning & Architecture

**Next Immediate Tasks:**
1. ~~Technical Stack Selection (1.1)~~ ✅ Complete
2. ~~Eye Tracking Approach (1.2)~~ ✅ Complete (native OS, large UI targets)
3. Database Schema Design (1.3)
4. Django Project Setup (2.1)
