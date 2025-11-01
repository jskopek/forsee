
import React from 'react';

const TextInput = ({ text, onClear, onSpeak }) => {
  return (
    <div className="text-input-container">
      <textarea className="text-input" value={text} readOnly />
      <div className="text-input-buttons">
        <button onClick={onClear}>Clear</button>
        <button onClick={onSpeak}>Play</button>
      </div>
    </div>
  );
};

export default TextInput;
