import React, { useState, useRef, useImperativeHandle, forwardRef } from 'react';

const Backspace = forwardRef(({ dwellTime, onBackspace, onClear, hasText }, ref) => {
  const [consecutiveBackspaceCount, setConsecutiveBackspaceCount] = useState(0);
  const [isHoveringBackspace, setIsHoveringBackspace] = useState(false);
  const backspaceIntervalRef = useRef(null);

  useImperativeHandle(ref, () => ({
    reset: () => {
      setConsecutiveBackspaceCount(0);
    }
  }));

  const handleBackspace = () => {
    setConsecutiveBackspaceCount((prevCount) => {
      const newCount = prevCount + 1;
      if (newCount >= 4) {
        // Clear entire text after 4 consecutive erases
        if (onClear) {
          onClear();
        }
        return 0;
      } else {
        // Single character delete
        if (onBackspace) {
          onBackspace();
        }
        return newCount;
      }
    });
  };

  const handleMouseEnter = () => {
    if (backspaceIntervalRef.current) {
      clearInterval(backspaceIntervalRef.current);
    }
    setIsHoveringBackspace(true);
    setConsecutiveBackspaceCount(0); // Reset counter when starting a new hover session
    backspaceIntervalRef.current = setInterval(() => {
      handleBackspace();
    }, dwellTime);
  };

  const handleMouseLeave = () => {
    if (backspaceIntervalRef.current) {
      clearInterval(backspaceIntervalRef.current);
      backspaceIntervalRef.current = null;
    }
    setIsHoveringBackspace(false);
    setConsecutiveBackspaceCount(0); // Reset counter when leaving backspace
  };

  const handleClick = () => {
    handleBackspace();
  };

  return (
    <div className="relative h-14 w-full flex items-center">
      <button
        className="relative h-14 w-full px-4 rounded-none border-none bg-transparent text-base cursor-pointer overflow-hidden text-white before:content-[''] before:absolute before:inset-0 before:bg-danger-back before:transition-colors before:duration-[120ms] before:ease-in-out before:rounded-none before:z-[1] after:content-[''] after:absolute after:inset-1 after:bg-danger-front after:border after:border-danger-border after:rounded-lg after:transition-colors after:duration-[120ms] after:ease-in-out after:z-[1] hover:before:bg-danger-back-hover hover:after:bg-danger-front-hover hover:after:border-danger-border-hover group"
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <span className="absolute inset-1 rounded-lg bg-white/28 origin-left z-[2] pointer-events-none animate-dwell-fill-repeat" aria-hidden="true" />
        <span className="relative z-[3] inline-flex items-center gap-2 leading-none">⌫ Backspace</span>
      </button>
      {/* Clear indicator */}
      {isHoveringBackspace && consecutiveBackspaceCount > 0 && consecutiveBackspaceCount < 4 && hasText && (
        <div className="absolute top-full left-1/2 transform -translate-x-1/2 mt-2 px-3 py-1.5 bg-danger-back border border-danger-border rounded-lg shadow-lg z-50 flex items-center gap-2 whitespace-nowrap">
          <svg
            className="w-4 h-4 text-white"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
          <span className="text-white text-sm font-semibold">
            {4 - consecutiveBackspaceCount} more to clear
          </span>
        </div>
      )}
    </div>
  );
});

Backspace.displayName = 'Backspace';

export default Backspace;

