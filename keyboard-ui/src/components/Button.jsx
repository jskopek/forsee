import React, { useRef, useEffect } from 'react';

const Button = ({
  label,
  icon,
  color = 'green',
  dwell = true,
  loading = false,
  onMouseEnter,
  onMouseLeave,
  onClick,
  className = '',
  style = {}
}) => {
  const hoverTimerRef = useRef(null);
  const buttonRef = useRef(null);

  const colorClasses = {
    green: 'before:bg-key-back after:bg-key-front after:border-key-border hover:before:bg-key-back-hover hover:after:bg-key-front-hover hover:after:border-key-border-hover',
    blue: 'before:bg-primary-back after:bg-gradient-to-br after:from-primary-gradient-start after:to-primary-gradient-end after:border-primary-border hover:before:bg-primary-back-hover hover:after:from-primary-gradient-start-hover hover:after:to-primary-gradient-end-hover hover:after:border-primary-border-hover',
    neutral: 'before:bg-neutral-back after:bg-neutral-front after:border-neutral-border hover:before:bg-neutral-back-hover hover:after:bg-neutral-front-hover hover:after:border-neutral-border-hover',
    space: 'before:bg-space-back after:bg-space-front after:border-space-border hover:before:bg-space-back-hover hover:after:bg-space-front-hover hover:after:border-space-border-hover'
  };

  const handleMouseEnter = () => {
    if (dwell && onClick) {
      // Get dwell time from CSS variable
      const dwellTime = buttonRef.current
        ? parseInt(getComputedStyle(buttonRef.current).getPropertyValue('--dwell-time')) || 1000
        : 1000;

      hoverTimerRef.current = setTimeout(() => {
        onClick();
      }, dwellTime);
    }
    if (onMouseEnter) {
      onMouseEnter();
    }
  };

  const handleMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    if (onMouseLeave) {
      onMouseLeave();
    }
  };

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);

  if (loading) {
    return (
      <div
        className="relative flex items-center justify-center w-full h-full bg-key-front/30 border border-key-border/30 rounded-lg mx-1 my-0.5 animate-pulse"
        style={style}
      >
        {icon ? (
          <div className="flex flex-col items-center justify-center gap-2">
            <div className="w-12 h-12 bg-gray-500/30 rounded"></div>
            <div className="h-4 bg-gray-500/30 rounded w-16"></div>
          </div>
        ) : (
          <div className="h-4 bg-gray-500/30 rounded w-3/4"></div>
        )}
      </div>
    );
  }

  return (
    <button
      ref={buttonRef}
      className={`relative flex flex-col items-center justify-center w-full h-full border-none outline-none bg-transparent text-white cursor-pointer overflow-hidden before:content-[''] before:absolute before:inset-0 before:transition-colors before:duration-[120ms] before:ease-in-out before:z-[1] after:content-[''] after:absolute after:inset-1 after:border after:rounded-lg after:transition-all after:duration-[120ms] after:ease-in-out after:z-[1] group ${colorClasses[color] || colorClasses.green} ${className}`}
      style={style}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={onClick}
    >
      {/* Always show dwell animation - controlled by CSS --dwell-time variable */}
      <span
        className="absolute inset-1 rounded-lg bg-white/28 origin-left z-[2] pointer-events-none animate-dwell-fill"
        aria-hidden="true"
      />
      {icon && <span className={`relative z-[3] text-4xl ${label ? 'mb-2' : ''}`}>{icon}</span>}
      {label && (
        <span className={`relative z-[3] font-semibold ${icon ? '' : 'text-2xl'}`}>
          {label}
        </span>
      )}
    </button>
  );
};

export default Button;
