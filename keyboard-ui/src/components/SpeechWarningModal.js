import React, { useState, useEffect, useRef, useImperativeHandle, forwardRef } from 'react';

const SpeechWarningModal = forwardRef(({ onSpeechEnabled }, ref) => {
  const [showWarning, setShowWarning] = useState(false);
  const [pendingText, setPendingText] = useState(null);
  const speechSynthesisUsed = useRef(false);

  // Actually test if speech synthesis can be used
  const testSpeechSynthesisAvailability = () => {
    if (!('speechSynthesis' in window)) {
      return false;
    }
    
    // If we've successfully used it before, it's available
    if (speechSynthesisUsed.current) {
      return true;
    }
    
    // Chrome can populate voices without unlocking speech synthesis
    // So we need to verify we've actually successfully spoken before
    // Just checking voices isn't enough - we need to have actually used it
    return false;
  };

  const handleSpeak = (phrase) => {
    if (!phrase) return;
    
    // Click handler - this is a direct user gesture, so speech synthesis should work
    try {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(phrase);
      
      let speechStarted = false;
      
      utterance.onstart = () => {
        // Speech started successfully - speech synthesis is enabled
        speechStarted = true;
        speechSynthesisUsed.current = true;
        setShowWarning(false);
        setPendingText(null);
        
        if (onSpeechEnabled) {
          onSpeechEnabled(phrase);
        }
      };
      
      utterance.onerror = (event) => {
        if (!speechStarted) {
          // If speech didn't start, it might not be enabled
          if (event.error === 'not-allowed' || event.error === 'network' || event.error === 'interrupted') {
            speechSynthesisUsed.current = false;
            setPendingText(phrase);
            setShowWarning(true);
          }
        }
      };
      
      utterance.onend = () => {
        // Speech completed successfully
        speechSynthesisUsed.current = true;
      };
      
      // Try to speak - this will work if speech synthesis is enabled
      speechSynthesis.speak(utterance);
      
      // Optimistically assume it will work (since we're in a user gesture handler)
      speechSynthesisUsed.current = true;
      setShowWarning(false);
      setPendingText(null);
      
    } catch (e) {
      console.error('Speech synthesis error:', e);
      if (!pendingText) {
        setPendingText(phrase);
      }
      setShowWarning(true);
      speechSynthesisUsed.current = false;
    }
  };

  // Expose methods to parent component
  useImperativeHandle(ref, () => ({
    isSpeechSynthesisAvailable: testSpeechSynthesisAvailability,
    checkAndShowWarning: (phrase) => {
      // Actually test if speech synthesis is available
      const isAvailable = testSpeechSynthesisAvailability();
      
      if (!isAvailable && phrase) {
        setShowWarning(true);
        setPendingText(phrase);
        return false;
      }
      return true;
    },
    speak: handleSpeak
  }));

  useEffect(() => {
    // Listen for any click on the page to try to enable speech synthesis
    const handleClick = () => {
      if (!speechSynthesisUsed.current && 'speechSynthesis' in window) {
        // If there's pending text, try to speak it directly (we're in a user gesture handler)
        if (pendingText && showWarning) {
          // Directly speak the pending text - this will enable speech synthesis
          handleSpeak(pendingText);
        } else {
          // No pending text, just try to enable speech synthesis with a test utterance
          try {
            speechSynthesis.cancel();
            const testUtterance = new SpeechSynthesisUtterance('');
            testUtterance.volume = 0;
            testUtterance.rate = 10; // Very fast
            
            let testStarted = false;
            
            testUtterance.onstart = () => {
              testStarted = true;
              speechSynthesisUsed.current = true;
              setShowWarning(false);
              // Cancel the test utterance after a short delay
              setTimeout(() => speechSynthesis.cancel(), 20);
            };
            
            testUtterance.onerror = (event) => {
              if (!testStarted && event.error !== 'interrupted') {
                // Speech synthesis not available yet
                speechSynthesisUsed.current = false;
              }
            };
            
            speechSynthesis.speak(testUtterance);
          } catch (e) {
            // Ignore errors during test
          }
        }
      } else if (speechSynthesisUsed.current && pendingText && showWarning) {
        // Speech synthesis is already enabled, speak the pending text directly
        handleSpeak(pendingText);
      }
    };
    
    document.addEventListener('click', handleClick);
    return () => {
      document.removeEventListener('click', handleClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingText, showWarning]);

  if (!showWarning) return null;

  return (
    <div 
      className="fixed top-0 left-0 right-0 bottom-0 z-[1000] flex items-center justify-center"
      role="alert"
    >
      {/* Backdrop overlay */}
      <div 
        className="absolute inset-0 bg-black/20 pointer-events-none"
      />
      {/* Modal content */}
      <div 
        className="relative bg-warning-bg border-2 border-warning-border rounded-lg p-4 shadow-[0_4px_12px_rgba(0,0,0,0.15)] max-w-[400px] mx-4 pointer-events-auto"
      >
        <strong className="block text-warning-text mb-2 text-base font-semibold">
          Speech synthesis requires user interaction
        </strong>
        <p className="my-1 text-warning-text text-[0.9rem] leading-[1.4]">
          Click anywhere on the page to enable speech synthesis. Your text will be spoken automatically once enabled.
        </p>
        {pendingText && (
          <p className="mt-2 pt-2 border-t border-warning-border italic text-warning-text text-[0.85rem]">
            Your text will be preserved: &quot;{pendingText}&quot;
          </p>
        )}
      </div>
    </div>
  );
});

SpeechWarningModal.displayName = 'SpeechWarningModal';

export default SpeechWarningModal;
