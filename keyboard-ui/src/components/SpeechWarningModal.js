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
        console.log('Speech synthesis error:', event.error);
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
    if (showWarning && pendingText) {
      // Add click listener to enable speech synthesis on any click
      const handleClick = () => {
        // If there's pending text and speech synthesis isn't enabled yet, enable it and speak
        if (!speechSynthesisUsed.current) {
          handleSpeak(pendingText);
        }
      };
      
      document.addEventListener('click', handleClick);
      return () => {
        document.removeEventListener('click', handleClick);
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showWarning, pendingText]);

  if (!showWarning) return null;

  return (
    <div 
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
      role="alert"
    >
      {/* Backdrop overlay */}
      <div 
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.2)',
          pointerEvents: 'none'
        }}
      />
      {/* Modal content */}
      <div 
        style={{
          position: 'relative',
          backgroundColor: '#fff3cd',
          border: '2px solid #ffc107',
          borderRadius: '8px',
          padding: '16px',
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          maxWidth: '400px',
          margin: '0 16px',
          pointerEvents: 'auto'
        }}
      >
        <strong style={{ display: 'block', color: '#856404', marginBottom: '8px', fontSize: '1rem', fontWeight: '600' }}>
          Speech synthesis requires user interaction
        </strong>
        <p style={{ margin: '4px 0', color: '#856404', fontSize: '0.9rem', lineHeight: '1.4' }}>
          Click anywhere on the page to enable speech synthesis. Your text will be spoken automatically once enabled.
        </p>
        {pendingText && (
          <p style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #ffc107', fontStyle: 'italic', color: '#856404', fontSize: '0.85rem' }}>
            Your text will be preserved: &quot;{pendingText}&quot;
          </p>
        )}
      </div>
    </div>
  );
});

SpeechWarningModal.displayName = 'SpeechWarningModal';

export default SpeechWarningModal;
