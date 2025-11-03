
import React from 'react';

const Keyboard = ({ onDwell, onDwellLeave }) => {
  const keys = [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm']
  ];

  return (
    <div className="keyboard">
      {keys.map((row, rowIndex) => (
        <div
          key={rowIndex}
          className="keyboard-row"
          style={{ gridTemplateColumns: `repeat(${row.length}, 1fr)` }}
        >
          {row.map((key) => (
            <button
              key={key}
              onMouseEnter={() => onDwell(key)}
              onMouseLeave={onDwellLeave}
              className="key key-letter"
            >
              <span className="key-label">{key.toUpperCase()}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
};

export default Keyboard;
