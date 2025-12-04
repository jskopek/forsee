import React from 'react';

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
            <button
              key={key}
              onMouseEnter={() => onDwell(key)}
              onMouseLeave={onDwellLeave}
              className="relative flex items-center justify-center w-full h-full border-none outline-none bg-transparent text-white text-2xl tracking-[1px] cursor-pointer overflow-hidden before:content-[''] before:absolute before:inset-0 before:bg-key-back before:transition-colors before:duration-[120ms] before:ease-in-out before:z-[1] after:content-[''] after:absolute after:inset-1 after:bg-key-front after:border after:border-key-border after:rounded-lg after:transition-colors after:duration-[120ms] after:ease-in-out after:z-[1] hover:before:bg-key-back-hover hover:after:bg-key-front-hover hover:after:border-key-border-hover group"
            >
              <span className="absolute inset-1 rounded-lg bg-white/28 origin-left z-[2] pointer-events-none animate-dwell-fill" aria-hidden="true" />
              <span className="relative z-[3] font-semibold">{key.toUpperCase()}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
};

export default Keyboard;
