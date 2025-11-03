import React, { useState, useEffect, useRef } from 'react';
import Keyboard from './components/Keyboard';
import Settings from './components/Settings';
import './App.css';

const App = () => {
  const [text, setText] = useState('');
  const [dwellTime, setDwellTime] = useState(1000);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const keyPressTimer = useRef(null);

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

  const handleDwell = (key) => {
    clearTimeout(keyPressTimer.current);
    keyPressTimer.current = setTimeout(() => {
      handleKeyPress(key);
    }, dwellTime);
  };

  const handleDwellLeave = () => {
    clearTimeout(keyPressTimer.current);
  };

  const handleSpeak = () => {
    const utterance = new SpeechSynthesisUtterance(text);
    speechSynthesis.speak(utterance);
  };

  const handleDwellTimeChange = (newDwellTime) => {
    setDwellTime(newDwellTime);
    localStorage.setItem('dwellTime', newDwellTime);
  };

  const toggleSettings = () => {
    setIsSettingsOpen(!isSettingsOpen);
  };

  return (
    <div className="App">
      {/* Top bar */}
      <div className="top-bar">
        <button
          className="btn btn-danger"
          onClick={() => handleKeyPress('backspace')}
          onMouseEnter={() => handleDwell('backspace')}
          onMouseLeave={handleDwellLeave}
        >
          ⌫ Backspace
        </button>
        <div className="typed-display" title={text || 'Start typing...'}>
          {text || 'Start typing...'}
        </div>
        <button
          className="btn btn-primary"
          onClick={handleSpeak}
        >
          ✈ Send
        </button>
      </div>

      {/* Secondary bar */}
      <div className="secondary-bar">
        <button
          className="btn btn-space"
          onClick={() => handleKeyPress('space')}
          onMouseEnter={() => handleDwell('space')}
          onMouseLeave={handleDwellLeave}
        >
          Space
        </button>
        <div className="suggestions" />
        <button className="btn btn-neutral" onClick={() => {}}>
          ← Back
        </button>
        <button className="btn btn-neutral" onClick={toggleSettings}>
          {isSettingsOpen ? 'Close Settings' : 'Settings'}
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