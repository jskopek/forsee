import React, { useState, useEffect, useRef, useMemo } from 'react';
import Pusher from 'pusher-js';
import Keyboard from './components/Keyboard';
import Settings from './components/Settings';
import Hints from './components/Hints';
import Suggestions from './components/Suggestions';
import SpeechWarningModal from './components/SpeechWarningModal';
import Backspace from './components/Backspace';
import Toast from './components/Toast';
import { createDefaultAutocompleteEngine } from './autocomplete';

const App = () => {
  const [text, setText] = useState('');
  const [dwellTime, setDwellTime] = useState(1000);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHintsOpen, setIsHintsOpen] = useState(false);
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const requestSeq = useRef(0);
  const speechWarningModalRef = useRef(null);
  const backspaceRef = useRef(null);
  
  // Toast state - empty string means hidden
  const [toastMessage, setToastMessage] = useState('');
  
  // Callback for active component to register refresh handler
  const refreshCallbackRef = useRef(null);

  const autocompleteEngine = useMemo(() => createDefaultAutocompleteEngine(), []);

  const keyPressTimer = useRef(null);

  // Extract conversation ID from URL query parameter
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const conversationIdParam = urlParams.get('id');
    if (conversationIdParam) {
      setConversationId(conversationIdParam);
    }
  }, []);

  useEffect(() => {
    const savedDwellTime = localStorage.getItem('dwellTime');
    if (savedDwellTime) {
      setDwellTime(parseInt(savedDwellTime, 10));
    }
  }, []);

  // Pusher connection for real-time updates
  useEffect(() => {
    if (!conversationId) {
      console.log('[Pusher] No conversationId, skipping');
      return;
    }

    const pusherKey = process.env.REACT_APP_PUSHER_KEY;
    const pusherCluster = process.env.REACT_APP_PUSHER_CLUSTER || 'us2';
    
    if (!pusherKey) {
      console.log('[Pusher] No PUSHER_KEY configured, skipping');
      return;
    }

    console.log('[Pusher] Connecting...');
    const pusher = new Pusher(pusherKey, {
      cluster: pusherCluster,
    });

    const channel = pusher.subscribe(`conversation-${conversationId}`);
    
    channel.bind('message_added', (data) => {
      console.log('[Pusher] 🔔 New message detected:', data);
      if (refreshCallbackRef.current) {
        refreshCallbackRef.current();
      }
    });

    channel.bind('pusher:subscription_succeeded', () => {
      console.log('[Pusher] ✅ Subscribed to channel');
    });

    channel.bind('pusher:subscription_error', (error) => {
      console.error('[Pusher] ❌ Subscription error:', error);
    });

    return () => {
      console.log('[Pusher] Cleaning up');
      pusher.unsubscribe(`conversation-${conversationId}`);
      pusher.disconnect();
    };
  }, [conversationId]);

  const handleKeyPress = (key) => {
    if (key === 'backspace') {
      setText((prevText) => prevText.slice(0, -1));
    } else if (key === 'space') {
      setText((prevText) => prevText + ' ');
    } else {
      setText((prevText) => prevText + key);
    }
    // Reset backspace counter on any key press
    if (backspaceRef.current) {
      backspaceRef.current.reset();
    }
  };

  const getCurrentPrefix = (t) => {
    const uptoCaret = t; // textarea is readOnly; we always append, so use full text
    const match = uptoCaret.match(/([a-zA-Z]+)$/);
    return match ? match[1].toLowerCase() : '';
  };

  useEffect(() => {
    const prefix = getCurrentPrefix(text);
    if (!prefix) {
      setSuggestions([]);
      return;
    }
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    autocompleteEngine
      .suggest(prefix, { limit: 3 })
      .then((result) => {
        if (requestSeq.current === seq) {
          setSuggestions(Array.isArray(result) ? result : []);
        }
      })
      .catch(() => {
        if (requestSeq.current === seq) setSuggestions([]);
      });
  }, [text, autocompleteEngine]);

  const applySuggestion = (word) => {
    setText((prevText) => {
      const prefix = getCurrentPrefix(prevText);
      if (!prefix) {
        return (prevText ? prevText + ' ' : '') + word + ' ';
      }
      // Replace the trailing prefix with the full word + space
      return prevText.replace(new RegExp(`${prefix}$`), word) + ' ';
    });
  };

  const handleDwell = (keyOrAction) => {
    clearTimeout(keyPressTimer.current);
    keyPressTimer.current = setTimeout(() => {
      if (typeof keyOrAction === 'function') {
        keyOrAction();
      } else {
        handleKeyPress(keyOrAction);
      }
    }, dwellTime);
  };

  const handleDwellLeave = () => {
    clearTimeout(keyPressTimer.current);
  };

  const handleSpeak = async (textToSpeak) => {
    // Handle event objects from onClick handlers
    const phraseToUse = typeof textToSpeak === 'string' ? textToSpeak : text || '';
    const phrase = phraseToUse.trim();
    if (!phrase) return;
    
    // Send message to API if conversationId is available
    // Always send as user when using the speak button
    if (conversationId) {
      try {
        const apiBaseUrl = process.env.REACT_APP_API_BASE_URL || window.API_BASE_URL || (process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : '');
        const response = await fetch(`${apiBaseUrl}/api/conversations/${conversationId}/messages`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ body: phrase, sender: 'user' }),
        });

        if (!response.ok) {
          throw new Error(response.status === 401 || response.status === 403 ? 'Authentication required' : response.status === 404 ? 'Conversation not found' : 'Failed to send message');
        }
      } catch (err) {
        console.error('Error sending message:', err);
        // Still proceed with speaking even if API call fails
      }
    }
    
    // Always try to speak - the modal will handle showing warnings if needed
    if (speechWarningModalRef.current) {
      speechWarningModalRef.current.speak(phrase);
      setText('');
    }
  };

  const handleSpeakAndClear = (phrase) => {
    const trimmedPhrase = (phrase || '').trim();
    if (!trimmedPhrase) return;
    
    // Check if speech synthesis is available using the modal's method
    if (speechWarningModalRef.current) {
      const isAvailable = speechWarningModalRef.current.checkAndShowWarning(trimmedPhrase);
      if (isAvailable) {
        // Speech synthesis is available, proceed with speaking
        speechWarningModalRef.current.speak(trimmedPhrase);
        setText('');
      }
      // Otherwise, Warning is shown, don't proceed with speaking
    }
  };

  const handleDwellTimeChange = (newDwellTime) => {
    setDwellTime(newDwellTime);
    localStorage.setItem('dwellTime', newDwellTime);
  };

  const toggleSettings = () => {
    setIsSettingsOpen(!isSettingsOpen);
    setIsHintsOpen(false); // Close hints when opening settings
    setIsSuggestionsOpen(false); // Close suggestions when opening settings
  };

  const toggleHints = () => {
    setIsHintsOpen(!isHintsOpen);
    setIsSettingsOpen(false); // Close settings when opening hints
    setIsSuggestionsOpen(false); // Close suggestions when opening hints
  };

  const toggleSuggestions = () => {
    setIsSuggestionsOpen(!isSuggestionsOpen);
    setIsSettingsOpen(false); // Close settings when opening suggestions
    setIsHintsOpen(false); // Close hints when opening suggestions
  };

  return (
    <div className="text-center min-h-screen flex flex-col bg-bg-main" style={{ '--dwell-time': `${dwellTime}ms` }}>
      {/* Top bar */}
      <div className="grid grid-cols-[1fr_2fr_1fr] gap-0 p-0 bg-white border-b-0 items-center">
        <Backspace
          ref={backspaceRef}
          dwellTime={dwellTime}
          onBackspace={() => setText((prevText) => prevText.slice(0, -1))}
          onClear={() => setText('')}
          hasText={text.length > 0}
          onShowToast={setToastMessage}
        />
        <div className="h-14 flex items-center justify-center bg-white border border-border-light rounded-md text-lg font-[system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji',sans-serif] px-3 overflow-hidden whitespace-nowrap text-ellipsis" title={text || 'Start typing...'}>
          {text || 'Start typing...'}
        </div>
        <button
          className="relative h-14 px-4 rounded-none border-none bg-transparent text-base cursor-pointer overflow-hidden text-white before:content-[''] before:absolute before:inset-0 before:bg-primary-back before:transition-colors before:duration-[120ms] before:ease-in-out before:rounded-none before:z-[1] after:content-[''] after:absolute after:inset-1 after:bg-gradient-to-br after:from-primary-gradient-start after:to-primary-gradient-end after:border after:border-primary-border after:rounded-lg after:transition-all after:duration-[120ms] after:ease-in-out after:z-[1] hover:before:bg-primary-back-hover hover:after:from-primary-gradient-start-hover hover:after:to-primary-gradient-end-hover hover:after:border-primary-border-hover group"
          onClick={handleSpeak}
          onMouseEnter={() => handleDwell(() => handleSpeak())}
          onMouseLeave={handleDwellLeave}
        >
          <span className="absolute inset-1 rounded-lg bg-white/28 origin-left z-[2] pointer-events-none animate-dwell-fill" aria-hidden="true" />
          <span className="relative z-[3] inline-flex items-center gap-2 leading-none">
            <svg
              className="w-6 h-6 block"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              stroke="currentColor"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {/* Head */}
              <circle cx="9" cy="12" r="5" />
              {/* Voice waves */}
              <path d="M17 10c1.75 1.75 1.75 3.5 0 5" />
              <path d="M20 8c2.75 2.75 2.75 7.25 0 10" />
            </svg>
            Speak
          </span>
        </button>
      </div>

      {/* Secondary bar */}
      <div className="grid grid-cols-[auto_1fr_auto] gap-0 p-0 bg-white border-b-0">
        <button
          className="relative h-14 px-4 rounded-none border-none bg-transparent text-base cursor-pointer overflow-hidden text-white min-w-[120px] before:content-[''] before:absolute before:inset-0 before:bg-space-back before:transition-colors before:duration-[120ms] before:ease-in-out before:rounded-none before:z-[1] after:content-[''] after:absolute after:inset-1 after:bg-space-front after:border after:border-space-border after:rounded-lg after:transition-colors after:duration-[120ms] after:ease-in-out after:z-[1] hover:before:bg-space-back-hover hover:after:bg-space-front-hover hover:after:border-space-border-hover group"
          onClick={() => handleKeyPress('space')}
          onMouseEnter={() => handleDwell('space')}
          onMouseLeave={handleDwellLeave}
        >
          <span className="absolute inset-1 rounded-lg bg-white/28 origin-left z-[2] pointer-events-none animate-dwell-fill" aria-hidden="true" />
          <span className="relative z-[3] inline-flex items-center gap-2 leading-none">Space</span>
        </button>
        <div className="grid grid-cols-3 gap-0 items-stretch">
          {suggestions.map((word) => (
            <button
              key={word}
              className="relative h-14 border-none bg-transparent cursor-pointer text-text-dark text-base before:content-[''] before:absolute before:inset-0 before:bg-suggestion-back before:rounded-none before:transition-colors before:duration-[120ms] before:ease-in-out before:z-[1] after:content-[''] after:absolute after:inset-[3px] after:bg-suggestion-front after:border after:border-suggestion-border after:rounded-lg after:transition-colors after:duration-[120ms] after:ease-in-out after:z-[1] hover:before:bg-suggestion-back-hover hover:after:bg-suggestion-front-hover hover:after:border-suggestion-border-hover group"
              onClick={() => applySuggestion(word)}
              onMouseEnter={() => handleDwell(() => applySuggestion(word))}
              onMouseLeave={handleDwellLeave}
            >
              <span className="absolute inset-[3px] rounded-lg bg-black/18 origin-left z-[2] pointer-events-none animate-dwell-fill" aria-hidden="true" />
              <span className="relative z-[3] font-semibold">{word}</span>
            </button>
          ))}
        </div>
        <div className="flex gap-0">
          <button
            className="relative h-14 px-4 rounded-none border-none bg-transparent text-base cursor-pointer overflow-hidden text-text-dark before:content-[''] before:absolute before:inset-0 before:bg-neutral-back before:transition-colors before:duration-[120ms] before:ease-in-out before:rounded-none before:z-[1] after:content-[''] after:absolute after:inset-1 after:bg-neutral-front after:border after:border-neutral-border after:rounded-lg after:transition-colors after:duration-[120ms] after:ease-in-out after:z-[1] hover:before:bg-neutral-back-hover hover:after:bg-neutral-front-hover hover:after:border-neutral-border-hover group"
            onClick={toggleSuggestions}
            onMouseEnter={() => handleDwell(() => toggleSuggestions())}
            onMouseLeave={handleDwellLeave}
          >
            <span className="absolute inset-1 rounded-lg bg-white/28 origin-left z-[2] pointer-events-none animate-dwell-fill" aria-hidden="true" />
            <span className="relative z-[3] inline-flex items-center gap-2 leading-none">{isSuggestionsOpen ? 'Close Suggestions' : 'Suggestions'}</span>
          </button>
          <button
            className="relative h-14 px-4 rounded-none border-none bg-transparent text-base cursor-pointer overflow-hidden text-text-dark before:content-[''] before:absolute before:inset-0 before:bg-neutral-back before:transition-colors before:duration-[120ms] before:ease-in-out before:rounded-none before:z-[1] after:content-[''] after:absolute after:inset-1 after:bg-neutral-front after:border after:border-neutral-border after:rounded-lg after:transition-colors after:duration-[120ms] after:ease-in-out after:z-[1] hover:before:bg-neutral-back-hover hover:after:bg-neutral-front-hover hover:after:border-neutral-border-hover group"
            onClick={toggleHints}
            onMouseEnter={() => handleDwell(() => toggleHints())}
            onMouseLeave={handleDwellLeave}
          >
            <span className="absolute inset-1 rounded-lg bg-white/28 origin-left z-[2] pointer-events-none animate-dwell-fill" aria-hidden="true" />
            <span className="relative z-[3] inline-flex items-center gap-2 leading-none">{isHintsOpen ? 'Close Hints' : 'Hints'}</span>
          </button>
          <button className="relative h-14 px-4 rounded-none border-none bg-transparent text-base cursor-pointer overflow-hidden text-text-dark before:content-[''] before:absolute before:inset-0 before:bg-neutral-back before:transition-colors before:duration-[120ms] before:ease-in-out before:rounded-none before:z-[1] after:content-[''] after:absolute after:inset-1 after:bg-neutral-front after:border after:border-neutral-border after:rounded-lg after:transition-colors after:duration-[120ms] after:ease-in-out after:z-[1] hover:before:bg-neutral-back-hover hover:after:bg-neutral-front-hover hover:after:border-neutral-border-hover" onClick={toggleSettings}>
            <span className="relative z-[3] inline-flex items-center gap-2 leading-none">{isSettingsOpen ? 'Close Settings' : 'Settings'}</span>
          </button>
        </div>
      </div>

      {isSettingsOpen && (
        <Settings
          initialDwellTime={dwellTime}
          onDwellTimeChange={handleDwellTimeChange}
        />
      )}

      {/* Keyboard, Hints, or Suggestions area fills the remaining space */}
      <div className="flex-1 flex p-0">
        {isSuggestionsOpen ? (
          <Suggestions 
            text={text} 
            onTextChange={setText} 
            dwellTime={dwellTime} 
            conversationId={conversationId} 
            onSpeak={handleSpeak}
            onShowToast={setToastMessage}
            onRegisterRefresh={(callback) => { 
              console.log('[App] Registering Suggestions refresh callback');
              refreshCallbackRef.current = callback; 
            }}
          />
        ) : isHintsOpen ? (
          <Hints 
            text={text} 
            onTextChange={setText} 
            dwellTime={dwellTime} 
            conversationId={conversationId}
            onShowToast={setToastMessage}
            onRegisterRefresh={(callback) => { 
              console.log('[App] Registering Hints refresh callback');
              refreshCallbackRef.current = callback; 
            }}
          />
        ) : (
          <Keyboard onDwell={handleDwell} onDwellLeave={handleDwellLeave} />
        )}
      </div>

      {/* Speech warning modal */}
      <SpeechWarningModal ref={speechWarningModalRef} onSpeechEnabled={(spokenText) => setText('')} />

      {/* Toast notification */}
      <Toast 
        message={toastMessage} 
        onClose={() => setToastMessage('')}
      />

      {/* no bottom utility row */}
    </div>
  );
};

export default App;