# Forsee Eye Tracking Keyboard

**A next-generation eye tracking keyboard that uses phrase-level AI autocomplete to bridge the gap between typical eye tracking speeds (15-30 WPM) and natural conversation speeds (150 WPM).**

## The Problem

Traditional eye tracking keyboards operate at 15-30 words per minute, while natural conversation flows at approximately 150 words per minute. This 5-10x speed gap creates a significant barrier for users who rely on eye tracking communication.

## Our Solution

Forsee reimagines eye tracking input by combining:
- **Phrase-level autocomplete** - Complete sentences, not just next-word prediction
- **LLM-powered suggestions** - Context-aware predictions using Groq/OpenAI models
- **Real-time streaming** - Suggestions appear as they're generated, not after completion
- **Dual input system** - Mix full-phrase selection with character-by-character typing
- **Word hints with visual aids** - Emoji-tagged word suggestions that inform phrase predictions

## Key Features

### 🎯 Phrase-Level Autocomplete
- Up to 6 full-phrase suggestions displayed simultaneously
- Intelligent predictions based on conversation context and partial input
- Streaming updates via Pusher for real-time generation
- Smart hover behavior that pauses updates while you're browsing options

### 💡 Contextual Word Hints
- 19 word suggestions with emoji visual aids
- Selected hints inform phrase predictions for better accuracy
- "More" button generates fresh hints excluding current ones
- Dynamic grid layout optimizes for eye tracking saccades

### 👁️ Dwell-Based Interaction
- Configurable dwell time (default 1000ms)
- Smooth fill animation provides visual progress feedback
- No clicking required - just look and wait
- Works with standard eye tracking hardware (replaces mouse hover)

### ⚡ Real-Time Streaming Architecture
- Backend generates suggestions continuously as you type
- Pusher integration delivers updates without polling
- FIFO queue management keeps newest predictions visible
- Loading indicators show generation progress

### 🗣️ Speech Output
- Built-in text-to-speech using Web Speech API
- Automatic browser permission handling
- Integrated with conversation logging

## How It Works

1. **Start typing** using the eye-optimized keyboard layout or select word hints
2. **Review suggestions** - AI generates complete phrase predictions in real-time
3. **Select your phrase** - Dwell on a suggestion to select it
4. **Speak** - Text-to-speech outputs your message and logs it to conversation
5. **Continue** - New context informs better predictions for your next message

### Input Composition Model

Your text is built from:
- **Keyboard prefix** (blue) - Characters typed using the on-screen keyboard
- **Selected hints** (gray) - Words you've chosen from suggestions
- **Combined view** - Both parts displayed in the input bar

This hybrid approach lets you:
- Quickly select common phrases
- Type specific words not in suggestions
- Build custom messages with word hints as building blocks

## Technology Stack

**Frontend:**
- React 19.2.0
- Tailwind CSS 3.4.18
- Pusher.js 8.4.0 (real-time streaming)

**Backend:**
- Python/Django
- Groq API (fast inference)
- OpenAI API (fallback/parallel support)

## Getting Started

### Prerequisites
- Node.js 14+
- npm or yarn
- Backend API running (separate repository)

### Installation

```bash
# Install dependencies
npm install

# Configure environment variables
cp .env.example .env

# Edit .env with your configuration:
# REACT_APP_PUSHER_KEY=your_pusher_key
# REACT_APP_PUSHER_CLUSTER=ap1
# REACT_APP_API_BASE_URL=http://localhost:8000
```

### Running the Application

```bash
# Development mode
npm start

# Production build
npm run build

# Run tests
npm test
```

The application will open at `http://localhost:3000`

## Configuration

### Environment Variables

- `REACT_APP_PUSHER_KEY` - Pusher application key for real-time updates
- `REACT_APP_PUSHER_CLUSTER` - Pusher cluster (default: ap1)
- `REACT_APP_API_BASE_URL` - Backend API URL (default: http://localhost:8000)

### User Settings

Access settings via the gear icon in the control bar:
- **Dwell Time** - Adjust hover duration before action triggers (default: 1000ms)

Settings persist in localStorage across sessions.

## Project Structure

```
src/
├── App.js                 # Main application container
├── components/
│   ├── ControlBar.js      # Backspace, space, settings, speak buttons
│   ├── Keyboard.js        # Eye-optimized character keyboard
│   ├── Suggestions.js     # Phrase-level autocomplete display
│   ├── Hints.js          # Word hints with emoji aids
│   ├── SettingsPanel.js  # Configuration modal
│   └── Toast.js          # Notification system
├── hooks/
│   └── useDwellClick.js  # Dwell-based interaction logic
└── index.css             # Tailwind configuration
```

## API Integration

The frontend expects these backend endpoints:

- `POST /api/conversations/{id}/suggestions/stream` - Fetch phrase suggestions
- `POST /api/conversations/{id}/hints/stream` - Fetch word hints
- `POST /api/conversations/{id}/messages` - Submit spoken message

All endpoints use Pusher for async streaming:
- `suggestion_ready` / `hint_ready` - Individual items arrive
- `suggestion_ready_complete` / `hint_ready_complete` - Batch finished
- `message_added` - External message received

## Eye Tracker Integration

The current implementation uses mouse hover as a proxy for eye gaze. To integrate with physical eye tracking hardware:

1. Replace `mouseenter`/`mouseleave` events in `useDwellClick.js` with eye gaze events
2. Map gaze coordinates to UI element hover states
3. Calibrate dwell time based on user testing
4. Consider adding gaze smoothing/filtering for stability

Common eye trackers with SDK support:
- Tobii Eye Tracker 5
- Gazepoint GP3
- Eye Tribe Tracker

## Keyboard Layout

The keyboard uses an optimized layout (not QWERTY) designed for eye tracking efficiency:

```
q w e r t y u i o p
 a s d f g h j k l
  z x c v b n m
```

Future versions may include:
- Frequency-based layouts
- User-customizable layouts
- Language-specific optimizations

## Performance Considerations

- Suggestions debounced at 300ms to reduce API calls
- FIFO queue limits display to 6 suggestions (memory efficient)
- Hover state prevents update spam while browsing
- Component memoization reduces unnecessary re-renders
- Pusher connection reused across all streaming requests

## Development Roadmap

- [ ] Eye tracker hardware integration
- [ ] A/B testing for optimal suggestion count
- [ ] Voice input as alternative modality
- [ ] Multi-language support
- [ ] Customizable keyboard layouts
- [ ] Advanced settings (model selection, temperature, etc.)
- [ ] Offline mode with cached predictions
- [ ] User profile learning (personalized suggestions)
- [ ] Accessibility compliance (WCAG 2.1 AA)

## Contributing

We welcome contributions! Please see CONTRIBUTING.md for guidelines.

## License

[Add your license here]

## Acknowledgments

Built with the goal of making high-speed communication accessible to everyone who relies on eye tracking technology.
