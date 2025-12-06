import React, { useCallback, useEffect, useRef } from 'react';
import Button from './Button';
import Backspace from './Backspace';

const Keyboard = ({ value, onChange, dwellTime, onShowToast }) => {
  const keys = [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['backspace', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'space']
  ];

  const keyPressTimer = useRef(null);
  const backspaceRef = useRef(null);

  useEffect(() => () => {
    clearTimeout(keyPressTimer.current);
  }, []);

  const handleKeyPress = useCallback((key) => {
    const charToAdd = key === 'space' ? ' ' : key;
    const nextValue = `${value}${charToAdd}`;
    onChange(nextValue);
    if (backspaceRef.current) {
      backspaceRef.current.reset();
    }
    console.log('[Keyboard] key press', { key, nextValue });
  }, [onChange, value]);

  const handleBackspace = useCallback(() => {
    const nextValue = value.slice(0, -1);
    onChange(nextValue);
  }, [onChange, value]);

  const handleClear = useCallback(() => {
    onChange('');
  }, [onChange]);

  const handleDwell = useCallback((keyOrAction) => {
    clearTimeout(keyPressTimer.current);
    keyPressTimer.current = setTimeout(() => {
      if (typeof keyOrAction === 'function') {
        keyOrAction();
      } else {
        handleKeyPress(keyOrAction);
      }
    }, dwellTime);
  }, [dwellTime, handleKeyPress]);

  const handleDwellLeave = useCallback(() => {
    clearTimeout(keyPressTimer.current);
  }, []);

  const renderKey = (key) => {
    if (key === 'backspace') {
      return (
        <Backspace
          key="backspace"
          ref={backspaceRef}
          dwellTime={dwellTime}
          onBackspace={handleBackspace}
          onClear={handleClear}
          hasText={value.length > 0}
          onShowToast={onShowToast}
          className="h-full"
        />
      );
    }

    if (key === 'space') {
      return (
        <button
          key="space"
          className="relative h-full px-4 rounded-none border-none bg-transparent text-base cursor-pointer overflow-hidden text-white min-w-[120px] before:content-[''] before:absolute before:inset-0 before:bg-space-back before:transition-colors before:duration-[120ms] before:ease-in-out before:rounded-none before:z-[1] after:content-[''] after:absolute after:inset-1 after:bg-space-front after:border after:border-space-border after:rounded-lg after:transition-all after:duration-[120ms] after:ease-in-out after:z-[1] hover:before:bg-space-back-hover hover:after:bg-space-front-hover hover:after:border-space-border-hover group"
          onClick={() => handleKeyPress('space')}
          onMouseEnter={() => handleDwell('space')}
          onMouseLeave={handleDwellLeave}
        >
          <span className="absolute inset-1 rounded-lg bg-white/28 origin-left z-[2] pointer-events-none animate-dwell-fill" aria-hidden="true" />
          <span className="relative z-[3] inline-flex items-center gap-2 leading-none">Space</span>
        </button>
      );
    }

    return (
      <Button
        key={key}
        label={key.toUpperCase()}
        color="green"
        dwell={false}
        loading={false}
        onMouseEnter={() => handleDwell(key)}
        onMouseLeave={handleDwellLeave}
        onClick={() => handleKeyPress(key)}
        className="tracking-[1px]"
      />
    );
  };

  return (
    <div className="flex-[1] flex flex-col gap-0 w-full min-h-0">
      {keys.map((row, rowIndex) => (
        <div
          key={rowIndex}
          className="grid gap-0 flex-1 items-stretch"
          style={{ gridTemplateColumns: `repeat(${row.length}, 1fr)`, gridAutoRows: '1fr' }}
        >
          {row.map((key) => renderKey(key))}
        </div>
      ))}
    </div>
  );
};

export default Keyboard;
