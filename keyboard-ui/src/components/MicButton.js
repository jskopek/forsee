import React from 'react';

const MicButton = ({ isRecording, status, onStart, onStop }) => {
  const isListening = status === 'recording' || status === 'starting';
  const handleClick = () => {
    if (isRecording) {
      onStop();
    } else {
      onStart();
    }
  };

  return (
    <button
      className={`relative h-14 px-4 rounded-none border-none bg-transparent text-base cursor-pointer overflow-hidden before:content-[''] before:absolute before:inset-0 before:transition-colors before:duration-[120ms] before:ease-in-out before:rounded-none before:z-[1] after:content-[''] after:absolute after:inset-1 after:border after:rounded-lg after:transition-colors after:duration-[120ms] after:ease-in-out after:z-[1] group ${
        isRecording || status === 'stopping'
          ? 'text-white before:bg-rose-500 after:bg-rose-500/90 after:border-rose-300 hover:before:bg-rose-600 hover:after:bg-rose-600/90 hover:after:border-rose-200'
          : 'text-text-dark before:bg-neutral-back after:bg-neutral-front after:border-neutral-border hover:before:bg-neutral-back-hover hover:after:bg-neutral-front-hover hover:after:border-neutral-border-hover'
      }`}
      onClick={handleClick}
      aria-pressed={isRecording}
      title={isRecording ? 'Stop microphone' : 'Start microphone'}
    >
      <span className="absolute inset-1 rounded-lg bg-white/24 origin-left z-[2] pointer-events-none animate-dwell-fill" aria-hidden="true" />
      <span className="relative z-[3] inline-flex items-center gap-2 leading-none">
        <svg
          className="w-5 h-5 block"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3a4 4 0 0 0-4 4v4a4 4 0 0 0 8 0V7a4 4 0 0 0-4-4Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <path d="M12 19v3" />
        </svg>
        {isRecording ? 'Stop' : 'Mic'}
        {isListening && (
          <span className="flex items-center gap-1 text-xs text-white/80">
            <span className="w-2 h-2 rounded-full bg-white animate-pulse" aria-hidden="true" />
            Listening
          </span>
        )}
      </span>
    </button>
  );
};

export default MicButton;
