import React, { useState, useRef, useImperativeHandle, forwardRef, useEffect } from 'react';

const Backspace = forwardRef(({ dwellTime, onBackspace, onClear, hasText, onShowToast, className = '' }, ref) => {
  const [consecutiveBackspaceCount, setConsecutiveBackspaceCount] = useState(0);
  const [isHoveringBackspace, setIsHoveringBackspace] = useState(false);
  const backspaceIntervalRef = useRef(null);

  useImperativeHandle(ref, () => ({
    reset: () => {
      setConsecutiveBackspaceCount(0);
    }
  }));

  // Show toast when backspace count changes
  useEffect(() => {
    if (isHoveringBackspace && consecutiveBackspaceCount > 0 && consecutiveBackspaceCount < 4 && hasText && onShowToast) {
      onShowToast(`${4 - consecutiveBackspaceCount} more backspace${4 - consecutiveBackspaceCount === 1 ? '' : 's'} to clear everything`);
    } else if (onShowToast && (!isHoveringBackspace || !hasText || consecutiveBackspaceCount >= 4 || consecutiveBackspaceCount === 0)) {
      // Dismiss toast immediately when:
      // - User stops hovering over backspace
      // - There's no more text
      // - We've cleared everything (count >= 4)
      // - Counter is reset to 0
      onShowToast('');
    }
  }, [consecutiveBackspaceCount, isHoveringBackspace, hasText, onShowToast]);

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
    <div className={`relative w-full flex items-stretch ${className}`}>
      <button
        className="relative h-full w-full px-4 rounded-none border-none bg-transparent text-base cursor-pointer overflow-hidden text-white before:content-[''] before:absolute before:inset-0 before:bg-danger-back before:transition-colors before:duration-[120ms] before:ease-in-out before:rounded-none before:z-[1] after:content-[''] after:absolute after:inset-1 after:bg-danger-front after:border after:border-danger-border after:rounded-lg after:transition-colors after:duration-[120ms] after:ease-in-out after:z-[1] hover:before:bg-danger-back-hover hover:after:bg-danger-front-hover hover:after:border-danger-border-hover group"
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <span className="absolute inset-1 rounded-lg bg-white/28 origin-left z-[2] pointer-events-none animate-dwell-fill-repeat" aria-hidden="true" />
        <span className="relative z-[3] inline-flex items-center gap-2 leading-none">⌫ Backspace</span>
      </button>
    </div>
  );
});

Backspace.displayName = 'Backspace';

export default Backspace;

