import React, { useState, useEffect, useRef } from 'react';
import Keyboard from './components/Keyboard';
import Settings from './components/Settings';
import './App.css';

const App = () => {
  const [text, setText] = useState('');
  const [dwellTime, setDwellTime] = useState(1000);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const suggestionWords = ['hello', 'help', 'how'];

  const keyPressTimer = useRef(null);
  const backspaceIntervalRef = useRef(null);

  useEffect(() => {
    const savedDwellTime = localStorage.getItem('dwellTime');
    if (savedDwellTime) {
      setDwellTime(parseInt(savedDwellTime, 10));
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
    return () => {
      if (backspaceIntervalRef.current) {
        clearInterval(backspaceIntervalRef.current);
      }
    };
  }, []);

  const handleSpeak = () => {
    const phrase = (text || '').trim();
    if (!phrase) return;
    const utterance = new SpeechSynthesisUtterance(phrase);
    speechSynthesis.speak(utterance);
    setText('');
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
          onMouseEnter={() => handleDwell(() => handleSpeak())}
          onMouseLeave={handleDwellLeave}
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
          {suggestionWords.map((word) => (
            <button
              key={word}
              className="suggestion dwellable"
              onClick={() => handleKeyPress(word + ' ')}
              onMouseEnter={() => handleDwell(word + ' ')}
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

      {/* no bottom utility row */}
    </div>
  );
};

export default App;