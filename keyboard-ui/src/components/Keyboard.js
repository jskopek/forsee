import React from 'react';
import Button from './Button';

const Keyboard = ({ onDwell, onDwellLeave }) => {
  const keys = [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm']
  ];

  return (
    <div className="flex-[1] flex flex-col gap-0 w-full min-h-0">
      {keys.map((row, rowIndex) => (
        <div
          key={rowIndex}
          className="grid gap-0 flex-1"
          style={{ gridTemplateColumns: `repeat(${row.length}, 1fr)` }}
        >
          {row.map((key) => (
            <Button
              key={key}
              label={key.toUpperCase()}
              color="green"
              dwell={false}
              loading={false}
              onMouseEnter={() => onDwell(key)}
              onMouseLeave={onDwellLeave}
              className="tracking-[1px]"
            />
          ))}
        </div>
      ))}
    </div>
  );
};

export default Keyboard;
