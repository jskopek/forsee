import React, { useState, useEffect, useRef, useMemo } from 'react';
import Keyboard from './components/Keyboard';
import Settings from './components/Settings';
import './App.css';
import { createDefaultAutocompleteEngine } from './autocomplete';

const App = () => {
  const [text, setText] = useState('');
  const [dwellTime, setDwellTime] = useState(1000);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [showSpeechWarning, setShowSpeechWarning] = useState(false);
  const [pendingSpeechText, setPendingSpeechText] = useState(null);
  const requestSeq = useRef(0);
  const speechSynthesisAvailable = useRef(false);
  const speechSynthesisUsed = useRef(false); // Track if speech synthesis has actually been used successfully

  const autocompleteEngine = useMemo(() => createDefaultAutocompleteEngine(), []);

  const keyPressTimer = useRef(null);
  const backspaceIntervalRef = useRef(null);

  useEffect(() => {
    const savedDwellTime = localStorage.getItem('dwellTime');
    if (savedDwellTime) {
      setDwellTime(parseInt(savedDwellTime, 10));
    }
    
    // Load voices when they become available (Chrome loads them asynchronously)
    if ('speechSynthesis' in window) {
      const loadVoices = () => {
        const voices = speechSynthesis.getVoices();
        if (voices.length > 0) {
          speechSynthesisAvailable.current = true;
        }
      };
      
      // Try to load voices immediately
      loadVoices();
      
      // Also listen for voiceschanged event
      speechSynthesis.addEventListener('voiceschanged', loadVoices);
      
      return () => {
        speechSynthesis.removeEventListener('voiceschanged', loadVoices);
      };
    }
  }, []);

  const handleKeyPress = (key) => {
    if (key === 'backspace') {
      setText((prevText) => prevText.slice(0, -1));
    } else if (key === 'space') {
      setText((prevText) => prevText + ' ');
    } else {
      setText((prevText) => prevText + key);
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

  useEffect(() => {
    if (showSpeechWarning && pendingSpeechText) {
      // Add click listener to enable speech synthesis on any click
      const handleClick = () => {
        // If there's pending text and speech synthesis isn't enabled yet, enable it and speak
        if (!speechSynthesisUsed.current) {
          const phrase = pendingSpeechText;
          try {
            speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(phrase);
            
            speechSynthesisUsed.current = true;
            setShowSpeechWarning(false);
            
            utterance.onstart = () => {
              speechSynthesisUsed.current = true;
            };
            
            utterance.onerror = (event) => {
              console.log('Speech synthesis error:', event.error);
              if (event.error === 'not-allowed' || event.error === 'network') {
                speechSynthesisUsed.current = false;
                setShowSpeechWarning(true);
              }
            };
            
            speechSynthesis.speak(utterance);
            setText('');
            setPendingSpeechText(null);
          } catch (e) {
            console.error('Speech synthesis error:', e);
            speechSynthesisUsed.current = false;
            setShowSpeechWarning(true);
          }
        }
      };
      
      document.addEventListener('click', handleClick);
      return () => {
        document.removeEventListener('click', handleClick);
      };
    }
  }, [showSpeechWarning, pendingSpeechText]);

  const checkSpeechSynthesisAvailable = () => {
    if (!('speechSynthesis' in window)) {
      return false;
    }
    // Chrome populates voices even without user interaction, but speak() still requires
    // a user gesture. So we check if we've actually successfully used speech synthesis before.
    // If not, we need a click first.
    return speechSynthesisUsed.current;
  };

  const handleSpeak = () => {
    // Determine what text to speak - prefer pending text if available, otherwise current text
    const phrase = pendingSpeechText || (text || '').trim();
    if (!phrase) return;
    
    // Click handler - this is a direct user gesture, so speech synthesis should work
    // Try to speak immediately (synchronously within the click handler)
    try {
      speechSynthesis.cancel(); // Cancel any pending speech
      const utterance = new SpeechSynthesisUtterance(phrase);
      
      // Mark that we've successfully initiated speech synthesis
      speechSynthesisUsed.current = true;
      setShowSpeechWarning(false);
      
      utterance.onstart = () => {
        // Speech started successfully
        speechSynthesisUsed.current = true;
      };
      
      utterance.onerror = (event) => {
        console.log('Speech synthesis error:', event.error);
        // If there's an error, it might mean speech synthesis isn't available
        if (event.error === 'not-allowed' || event.error === 'network') {
          speechSynthesisUsed.current = false;
          setPendingSpeechText(phrase);
          setShowSpeechWarning(true);
        }
      };
      
      speechSynthesis.speak(utterance);
      
      // Clear both current text and pending text
      setText('');
      setPendingSpeechText(null);
    } catch (e) {
      console.error('Speech synthesis error:', e);
      // If speaking fails, preserve text and show warning
      if (!pendingSpeechText) {
        setPendingSpeechText(phrase);
      }
      setShowSpeechWarning(true);
      speechSynthesisUsed.current = false;
    }
  };

  const handleSpeakHover = () => {
    const phrase = (text || '').trim();
    if (!phrase) {
      handleDwell(() => handleSpeak());
      return;
    }
    
    // Check if speech synthesis has been successfully used before
    // If not, we need a click first because hover-triggered speech won't work
    const isAvailable = checkSpeechSynthesisAvailable();
    
    // If not available (never successfully used), show warning and preserve text
    if (!isAvailable) {
      setShowSpeechWarning(true);
      setPendingSpeechText(phrase);
      return;
    }
    
    // Speech synthesis is available, proceed with normal dwell
    setShowSpeechWarning(false);
    handleDwell(() => handleSpeak());
  };

  const handleSpeakHoverLeave = () => {
    handleDwellLeave();
    // Don't hide warning on hover leave - keep it persistent until speech synthesis is enabled
  };

  const handleDwellTimeChange = (newDwellTime) => {
    setDwellTime(newDwellTime);
    localStorage.setItem('dwellTime', newDwellTime);
  };

  const toggleSettings = () => {
    setIsSettingsOpen(!isSettingsOpen);
  };

  return (
    <div className="App" style={{ '--dwell-time': `${dwellTime}ms` }}>
      {/* Top bar */}
      <div className="top-bar">
        <button
          className="btn btn-danger dwellable repeat"
          onClick={() => handleKeyPress('backspace')}
          onMouseEnter={() => {
            if (backspaceIntervalRef.current) {
              clearInterval(backspaceIntervalRef.current);
            }
            backspaceIntervalRef.current = setInterval(() => {
              handleKeyPress('backspace');
            }, dwellTime);
          }}
          onMouseLeave={() => {
            if (backspaceIntervalRef.current) {
              clearInterval(backspaceIntervalRef.current);
              backspaceIntervalRef.current = null;
            }
          }}
        >
          <span className="dwell-progress" aria-hidden="true" />
          <span className="btn-label">⌫ Backspace</span>
        </button>
        <div className="typed-display" title={text || 'Start typing...'}>
          {text || 'Start typing...'}
        </div>
        <button
          className="btn btn-primary dwellable"
          onClick={handleSpeak}
          onMouseEnter={handleSpeakHover}
          onMouseLeave={handleSpeakHoverLeave}
        >
          <span className="dwell-progress" aria-hidden="true" />
          <span className="btn-label">
            <svg
              className="icon"
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
      <div className="secondary-bar">
        <button
          className="btn btn-space dwellable"
          onClick={() => handleKeyPress('space')}
          onMouseEnter={() => handleDwell('space')}
          onMouseLeave={handleDwellLeave}
        >
          <span className="dwell-progress" aria-hidden="true" />
          <span className="btn-label">Space</span>
        </button>
        <div className="suggestions">
          {suggestions.map((word) => (
            <button
              key={word}
              className="suggestion dwellable"
              onClick={() => applySuggestion(word)}
              onMouseEnter={() => handleDwell(() => applySuggestion(word))}
              onMouseLeave={handleDwellLeave}
            >
              <span className="dwell-progress" aria-hidden="true" />
              <span className="suggestion-label">{word}</span>
            </button>
          ))}
        </div>
        <button className="btn btn-neutral" onClick={toggleSettings}>
          <span className="btn-label">{isSettingsOpen ? 'Close Settings' : 'Settings'}</span>
        </button>
      </div>

      {isSettingsOpen && (
        <Settings
          initialDwellTime={dwellTime}
          onDwellTimeChange={handleDwellTimeChange}
        />
      )}

      {/* Keyboard area fills the remaining space */}
      <div className="keyboard-wrapper">
        <Keyboard onDwell={handleDwell} onDwellLeave={handleDwellLeave} />
      </div>

      {/* Speech warning modal */}
      {showSpeechWarning && (
        <div 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          role="alert"
        >
          {/* Backdrop overlay */}
          <div 
            style={{
              position: 'absolute',
              inset: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.2)',
              pointerEvents: 'none'
            }}
          />
          {/* Modal content */}
          <div 
            style={{
              position: 'relative',
              backgroundColor: '#fff3cd',
              border: '2px solid #ffc107',
              borderRadius: '8px',
              padding: '16px',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
              maxWidth: '400px',
              margin: '0 16px',
              pointerEvents: 'auto'
            }}
          >
            <strong style={{ display: 'block', color: '#856404', marginBottom: '8px', fontSize: '1rem', fontWeight: '600' }}>
              Speech synthesis requires user interaction
            </strong>
            <p style={{ margin: '4px 0', color: '#856404', fontSize: '0.9rem', lineHeight: '1.4' }}>
              Click anywhere on the page to enable speech synthesis. Your text will be spoken automatically once enabled.
            </p>
            {pendingSpeechText && (
              <p style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #ffc107', fontStyle: 'italic', color: '#856404', fontSize: '0.85rem' }}>
                Your text will be preserved: &quot;{pendingSpeechText}&quot;
              </p>
            )}
          </div>
        </div>
      )}

      {/* no bottom utility row */}
    </div>
  );
};

export default App;