import React, { useState, useEffect, useRef } from 'react';
import Keyboard from './components/Keyboard';
import TextInput from './components/TextInput';
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

  const handleClear = () => {
    setText('');
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
      <header className="App-header">
        <h1>Eye-Tracking Keyboard</h1>
        <button onClick={toggleSettings}>
          {isSettingsOpen ? 'Close Settings' : 'Open Settings'}
        </button>
      </header>
      {isSettingsOpen && (
        <Settings
          initialDwellTime={dwellTime}
          onDwellTimeChange={handleDwellTimeChange}
        />
      )}
      <TextInput text={text} onClear={handleClear} onSpeak={handleSpeak} />
      <Keyboard onDwell={handleDwell} onDwellLeave={handleDwellLeave} />
    </div>
  );
};

export default App;