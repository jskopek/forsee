import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Pusher from 'pusher-js';
import Keyboard from './components/Keyboard';
import Settings from './components/Settings';
import SpeechWarningModal from './components/SpeechWarningModal';
import Backspace from './components/Backspace';
import Toast from './components/Toast';
import Layout from './components/Layout';
import PluginManager from './plugins/PluginManager';
import SuggestionsPlugin from './plugins/SuggestionsPlugin';
import HintsPlugin from './plugins/HintsPlugin';

const App = () => {
  const [currentText, setCurrentText] = useState('');
  const [keyboardPrefix, setKeyboardPrefix] = useState('');
  const [selectedHints, setSelectedHints] = useState([]);
  const [conversationTitle, setConversationTitle] = useState('');
  const [recentMessages, setRecentMessages] = useState([]);
  const [dwellTime, setDwellTime] = useState(1000);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState('idle'); // idle | starting | recording | stopping
  const speechWarningModalRef = useRef(null);
  const backspaceRef = useRef(null);
  const currentTextRef = useRef('');
  const keyboardPrefixRef = useRef('');
  const selectedHintsRef = useRef([]);
  const dwellTimeRef = useRef(1000);
  const recentMessagesRef = useRef([]);
  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const voiceStreamIdRef = useRef(null);
  const voiceChunkSeqRef = useRef(0);
  const voiceStopTimeoutRef = useRef(null);
  const pendingFinalChunkRef = useRef(false);
  const apiBaseUrl =
    process.env.REACT_APP_API_BASE_URL ||
    window.API_BASE_URL ||
    (process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : '');

  const setSelectedHintsWithRef = useCallback((updater) => {
    setSelectedHints((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      selectedHintsRef.current = next;
      return next;
    });
  }, [apiBaseUrl]);

  // Toast state
  const [toastMessage, setToastMessage] = useState('');

  const keyPressTimer = useRef(null);
  const pusherRef = useRef(null);
  const MAX_VOICE_RECORDING_MS = 45000;

  // Extract conversation ID from URL
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const conversationIdParam = urlParams.get('id');
    if (conversationIdParam) {
      setConversationId(conversationIdParam);
    }
  }, []);

  const fetchConversationContext = useCallback(async (conversationIdToFetch) => {
    if (!conversationIdToFetch) return;

    try {
      const response = await fetch(`${apiBaseUrl}/api/conversations/${conversationIdToFetch}/context`);
      if (!response.ok) {
        throw new Error(`Failed to fetch conversation context (${response.status})`);
      }
      const data = await response.json();
      setConversationTitle(data.title || '');
      setRecentMessages(data.messages || []);
    } catch (err) {
      console.error('[App] Error fetching conversation context:', err);
    }
  }, []);

  // Load dwell time from localStorage
  useEffect(() => {
    const savedDwellTime = localStorage.getItem('dwellTime');
    if (savedDwellTime) {
      setDwellTime(parseInt(savedDwellTime, 10));
    }
  }, []);

  // Keep refs in sync with state to avoid stale closures in plugin contexts
  useEffect(() => {
    currentTextRef.current = currentText;
  }, [currentText]);

  useEffect(() => {
    keyboardPrefixRef.current = keyboardPrefix;
  }, [keyboardPrefix]);

  useEffect(() => {
    selectedHintsRef.current = selectedHints;
  }, [selectedHints]);

  useEffect(() => {
    dwellTimeRef.current = dwellTime;
  }, [dwellTime]);

  useEffect(() => {
    recentMessagesRef.current = recentMessages;
  }, [recentMessages]);

  // Initialize Pusher for message_added events
  useEffect(() => {
    if (!conversationId) return;

    const pusherKey = process.env.REACT_APP_PUSHER_KEY;
    const pusherCluster = process.env.REACT_APP_PUSHER_CLUSTER || 'us2';

    if (!pusherKey) return;

    const pusher = new Pusher(pusherKey, {
      cluster: pusherCluster,
    });

    const channel = pusher.subscribe(`conversation-${conversationId}`);

    channel.bind('message_added', (data) => {
      fetchConversationContext(conversationId);
      // PluginManager will notify plugins
      if (pluginManagerRef.current) {
        pluginManagerRef.current.notifyMessageAdded();
      }
    });

    pusherRef.current = pusher;

    return () => {
      pusher.unsubscribe(`conversation-${conversationId}`);
      pusher.disconnect();
    };
  }, [apiBaseUrl, conversationId, fetchConversationContext]);

  // Create PluginManager
  const pluginManagerRef = useRef(null);
  const [pluginManagerReady, setPluginManagerReady] = useState(false);

  useEffect(() => {
    if (!conversationId) return;

    fetchConversationContext(conversationId);

    // Create plugin manager
    const manager = new PluginManager(conversationId, pusherRef.current);

    // Set up state getters
    manager.setStateGetters({
      getCurrentText: () => currentTextRef.current,
      getKeyboardPrefix: () => keyboardPrefixRef.current,
      getSelectedHints: () => selectedHintsRef.current,
      getConversationTitle: () => conversationTitle,
      getRecentMessages: () => recentMessagesRef.current,
      getDwellTime: () => dwellTimeRef.current,
      speak: handleSpeak,
      addMessage: handleAddMessage,
      setSelectedHints: (updater) => setSelectedHintsWithRef(updater),
    });

    // Register plugins
    manager.register(SuggestionsPlugin);
    manager.register(HintsPlugin);

    // Mount plugins
    manager.mountAll();

    pluginManagerRef.current = manager;
    setPluginManagerReady(true);
    return () => {
      manager.unmountAll();
      setPluginManagerReady(false);
    };
  }, [conversationId, fetchConversationContext]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleKeyPress = (key) => {
    const charToAdd = key === 'space' ? ' ' : key;
    setKeyboardPrefix((prev) => {
      const nextValue = prev + charToAdd;
      setCurrentText(nextValue);
      console.log('[Keyboard] key press', { key, nextValue });
      return nextValue;
    });
    if (backspaceRef.current) {
      backspaceRef.current.reset();
    }
  };

  const handlePrefixBackspace = () => {
    setKeyboardPrefix((prev) => {
      const nextValue = prev.slice(0, -1);
      setCurrentText(nextValue);
      return nextValue;
    });
  };

  const handlePrefixClear = () => {
    setKeyboardPrefix('');
    setCurrentText('');
  };

  // Hint toggling handled by plugins now
  // const handleHintToggle = (word, isSelected) => {
  //   setSelectedHints((prev) => {
  //     const normalizedWord = word.toLowerCase();
  //     if (isSelected) {
  //       return prev.filter((hint) => hint.toLowerCase() !== normalizedWord);
  //     }
  //     if (prev.some((hint) => hint.toLowerCase() === normalizedWord)) {
  //       return prev;
  //     }
  //     return [...prev, word];
  //   });
  // };

  const handleDwell = (keyOrAction) => {
    clearTimeout(keyPressTimer.current);
    keyPressTimer.current = setTimeout(() => {
      if (typeof keyOrAction === 'function') {
        keyOrAction();
      } else {
        handleKeyPress(keyOrAction);
      }
    }, dwellTime);
  };

  const handleDwellLeave = () => {
    clearTimeout(keyPressTimer.current);
  };

  const handleSpeak = useCallback(async (textToSpeak) => {
    const phraseToUse = typeof textToSpeak === 'string' ? textToSpeak : currentText || '';
    const phrase = phraseToUse.trim();
    if (!phrase) return;

    // Send message to API if conversationId is available
    if (conversationId) {
      await handleAddMessage(phrase, 'user');
    }

    // Speak via speech API
    if (speechWarningModalRef.current) {
      speechWarningModalRef.current.speak(phrase);
      setCurrentText('');
      setKeyboardPrefix('');
    }
  }, [conversationId, currentText]);

  const handleAddMessage = useCallback(async (body, sender = 'user') => {
    if (!conversationId) return;

    try {
      const response = await fetch(`${apiBaseUrl}/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ body, sender }),
      });

      if (!response.ok) {
        throw new Error('Failed to send message');
      }

      // Refresh local conversation context after sending
      fetchConversationContext(conversationId);
    } catch (err) {
      console.error('Error sending message:', err);
      setToastMessage('Failed to send message');
    }
  }, [conversationId, fetchConversationContext]);

  // Keep PluginManager getters in sync with latest state
  useEffect(() => {
    if (!pluginManagerRef.current) return;
    pluginManagerRef.current.setStateGetters({
      getCurrentText: () => currentText,
      getKeyboardPrefix: () => keyboardPrefix,
      getSelectedHints: () => selectedHints,
      getConversationTitle: () => conversationTitle,
      getRecentMessages: () => recentMessages,
      getDwellTime: () => dwellTime,
      speak: handleSpeak,
      addMessage: handleAddMessage,
      setSelectedHints: (updater) => setSelectedHintsWithRef(updater),
    });
  }, [currentText, keyboardPrefix, selectedHints, conversationTitle, recentMessages, dwellTime, handleSpeak, handleAddMessage, setSelectedHintsWithRef]);

  const handleDwellTimeChange = (newDwellTime) => {
    setDwellTime(newDwellTime);
    localStorage.setItem('dwellTime', newDwellTime);
  };

  const cleanupVoiceTimeout = useCallback(() => {
    if (voiceStopTimeoutRef.current) {
      clearTimeout(voiceStopTimeoutRef.current);
      voiceStopTimeoutRef.current = null;
    }
  }, []);

  const stopMediaTracks = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  }, []);

  const sendVoiceChunk = useCallback(async (audioBlob, isFinal = false) => {
    if (!voiceStreamIdRef.current || !conversationId) return;

    const formData = new FormData();
    formData.append('stream_id', voiceStreamIdRef.current);
    formData.append('seq', String(voiceChunkSeqRef.current));
    formData.append('is_final', String(isFinal));
    formData.append('audio', audioBlob, `chunk-${voiceChunkSeqRef.current}.webm`);
    voiceChunkSeqRef.current += 1;

    try {
      const response = await fetch(`${apiBaseUrl}/api/conversations/${conversationId}/voice/chunk`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Failed to send audio chunk (${response.status})`);
      }

      if (isFinal) {
        voiceStreamIdRef.current = null;
      }
    } catch (err) {
      console.error('[Voice] Chunk upload failed', err);
      setToastMessage('Voice upload failed');
    }
  }, [apiBaseUrl, conversationId]);

  const stopVoiceRecording = useCallback((isAutoStop = false) => {
    if (!mediaRecorderRef.current) return;

    pendingFinalChunkRef.current = true;
    setRecordingStatus('stopping');
    cleanupVoiceTimeout();

    try {
      mediaRecorderRef.current.stop();
    } catch (err) {
      console.error('[Voice] Error stopping recorder', err);
    }

    if (isAutoStop) {
      setToastMessage('Recording stopped (time limit reached)');
    }
  }, [cleanupVoiceTimeout]);

  const startVoiceRecording = useCallback(async () => {
    if (!conversationId) {
      setToastMessage('Open a conversation to record');
      return;
    }

    if (isRecording || recordingStatus === 'starting') return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setToastMessage('Microphone is not available in this browser');
      return;
    }

    try {
      setRecordingStatus('starting');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const startResponse = await fetch(`${apiBaseUrl}/api/conversations/${conversationId}/voice/start`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });

      if (!startResponse.ok) {
        throw new Error(`Failed to start voice stream (${startResponse.status})`);
      }

      const startData = await startResponse.json();
      voiceStreamIdRef.current = startData.stream_id;
      voiceChunkSeqRef.current = 0;
      pendingFinalChunkRef.current = false;

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size > 0) {
          const isFinalChunk = pendingFinalChunkRef.current && recorder.state === 'inactive';
          sendVoiceChunk(event.data, isFinalChunk);
        }
      });

      recorder.addEventListener('error', (event) => {
        console.error('[Voice] Recorder error', event.error);
        setToastMessage('Microphone error');
        stopVoiceRecording(true);
      });

      recorder.addEventListener('stop', () => {
        setIsRecording(false);
        setRecordingStatus('idle');
        cleanupVoiceTimeout();
        stopMediaTracks();
        pendingFinalChunkRef.current = false;
        mediaRecorderRef.current = null;
      });

      recorder.start(1500); // send chunks every 1.5s
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      setRecordingStatus('recording');

      voiceStopTimeoutRef.current = window.setTimeout(() => stopVoiceRecording(true), MAX_VOICE_RECORDING_MS);
    } catch (err) {
      console.error('[Voice] Unable to start recording', err);
      setToastMessage('Unable to start microphone');
      setIsRecording(false);
      setRecordingStatus('idle');
      cleanupVoiceTimeout();
      stopMediaTracks();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // ignore
        }
      }
      mediaRecorderRef.current = null;
    }
  }, [apiBaseUrl, cleanupVoiceTimeout, conversationId, isRecording, recordingStatus, sendVoiceChunk, stopMediaTracks, stopVoiceRecording]);

  useEffect(() => {
    return () => {
      cleanupVoiceTimeout();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop();
        } catch (err) {
          console.error('[Voice] Error cleaning up recorder', err);
        }
      }
      stopMediaTracks();
    };
  }, [cleanupVoiceTimeout, stopMediaTracks]);

  const toggleSettings = () => {
    setIsSettingsOpen((prev) => !prev);
  };

  const buildDisplayText = () => {
    if (currentText) {
      return currentText;
    }

    const parts = [];
    if (keyboardPrefix) {
      parts.push(keyboardPrefix);
    }
    if (selectedHints.length > 0) {
      parts.push(selectedHints.join(' '));
    }

    return parts.length > 0 ? parts.join(' ') : 'Start typing...';
  };

  const displayText = buildDisplayText();

  // Get plugin contexts for rendering
  // Build contexts directly with current state to avoid stale getter issues
  const suggestionsContext = useMemo(() => {
    if (!pluginManagerReady || !pluginManagerRef.current) {
      return null;
    }
    // Build context directly with current state instead of using getters
    // to avoid race condition where getters are updated in an effect
    const manager = pluginManagerRef.current;
    console.log('[App] Building suggestionsContext', { selectedHints });
    return {
      conversationId,
      conversationTitle,
      recentMessages,
      currentText,
      keyboardPrefix,
      selectedHints,
      setSelectedHints: setSelectedHintsWithRef,
      dwellTime,
      settings: manager.getSettings('builtin.suggestions'),
      llmRequest: manager.llmRequestForPlugin.bind(manager),
      refreshOtherPlugins: manager.refreshOtherPlugins.bind(manager),
      speak: handleSpeak,
      addMessage: handleAddMessage,
    };
  }, [pluginManagerReady, conversationId, currentText, keyboardPrefix, selectedHints, conversationTitle, recentMessages, dwellTime, handleSpeak, handleAddMessage, setSelectedHintsWithRef]);

  const hintsContext = useMemo(() => {
    if (!pluginManagerReady || !pluginManagerRef.current) {
      return null;
    }
    // Build context directly with current state instead of using getters
    const manager = pluginManagerRef.current;
    return {
      conversationId,
      conversationTitle,
      recentMessages,
      currentText,
      keyboardPrefix,
      selectedHints,
      setSelectedHints: setSelectedHintsWithRef,
      dwellTime,
      settings: manager.getSettings('builtin.hints'),
      llmRequest: manager.llmRequestForPlugin.bind(manager),
      refreshOtherPlugins: manager.refreshOtherPlugins.bind(manager),
      speak: handleSpeak,
      addMessage: handleAddMessage,
    };
  }, [pluginManagerReady, conversationId, currentText, keyboardPrefix, selectedHints, conversationTitle, recentMessages, dwellTime, handleSpeak, handleAddMessage, setSelectedHintsWithRef]);

  return (
    <div className="text-center min-h-screen flex flex-col bg-bg-main" style={{ '--dwell-time': `${dwellTime}ms` }}>
      <div className="flex flex-1 min-h-0 border-[25px] border-l-0 border-border-light bg-bg-main overflow-hidden">
        <div className="flex flex-col flex-1 min-h-0">
          {/* Top bar */}
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] gap-2 px-3 py-0 bg-white border-b-0 items-center">
            <Backspace
              ref={backspaceRef}
              dwellTime={dwellTime}
              onBackspace={handlePrefixBackspace}
              onClear={handlePrefixClear}
              hasText={keyboardPrefix.length > 0}
              onShowToast={setToastMessage}
            />
            <div
              className="h-14 flex items-center justify-start bg-white border border-border-light rounded-md text-lg font-[system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji',sans-serif] px-3 min-w-0 overflow-hidden whitespace-nowrap text-ellipsis"
              title={displayText}
            >
              {currentText ? (
                <span>{currentText}</span>
              ) : (
                <>
                  {keyboardPrefix && (
                    <span className="font-bold text-blue-600">{keyboardPrefix}</span>
                  )}
                  {keyboardPrefix && selectedHints.length > 0 && <span>&nbsp;</span>}
                  {selectedHints.length > 0 && (
                    <span className="text-gray-600">{selectedHints.join(' ')}</span>
                  )}
                  {!keyboardPrefix && selectedHints.length === 0 && (
                    <span className="text-gray-400">Start typing...</span>
                  )}
                </>
              )}
            </div>
            <button
              className="relative h-14 px-4 rounded-none border-none bg-transparent text-base cursor-pointer overflow-hidden text-white min-w-[120px] before:content-[''] before:absolute before:inset-0 before:bg-space-back before:transition-colors before:duration-[120ms] before:ease-in-out before:rounded-none before:z-[1] after:content-[''] after:absolute after:inset-1 after:bg-space-front after:border after:border-space-border after:rounded-lg after:transition-all after:duration-[120ms] after:ease-in-out after:z-[1] hover:before:bg-space-back-hover hover:after:bg-space-front-hover hover:after:border-space-border-hover group"
              onClick={() => handleKeyPress('space')}
              onMouseEnter={() => handleDwell('space')}
              onMouseLeave={handleDwellLeave}
            >
              <span className="absolute inset-1 rounded-lg bg-white/28 origin-left z-[2] pointer-events-none animate-dwell-fill" aria-hidden="true" />
              <span className="relative z-[3] inline-flex items-center gap-2 leading-none">Space</span>
            </button>
            <div className="flex items-center justify-end gap-2 pr-1">
              <button
                className={`relative h-14 px-4 rounded-none border-none bg-transparent text-base cursor-pointer overflow-hidden before:content-[''] before:absolute before:inset-0 before:transition-colors before:duration-[120ms] before:ease-in-out before:rounded-none before:z-[1] after:content-[''] after:absolute after:inset-1 after:border after:rounded-lg after:transition-colors after:duration-[120ms] after:ease-in-out after:z-[1] group ${
                  recordingStatus === 'recording' || recordingStatus === 'stopping'
                    ? 'text-white before:bg-rose-500 after:bg-rose-500/90 after:border-rose-300 hover:before:bg-rose-600 hover:after:bg-rose-600/90 hover:after:border-rose-200'
                    : 'text-text-dark before:bg-neutral-back after:bg-neutral-front after:border-neutral-border hover:before:bg-neutral-back-hover hover:after:bg-neutral-front-hover hover:after:border-neutral-border-hover'
                }`}
                onClick={() => (isRecording ? stopVoiceRecording() : startVoiceRecording())}
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
                  {(recordingStatus === 'recording' || recordingStatus === 'starting') && (
                    <span className="flex items-center gap-1 text-xs text-white/80">
                      <span className="w-2 h-2 rounded-full bg-white animate-pulse" aria-hidden="true" />
                      Listening
                    </span>
                  )}
                </span>
              </button>
              <button
                className="relative h-14 px-4 rounded-none border-none bg-transparent text-base cursor-pointer overflow-hidden text-text-dark before:content-[''] before:absolute before:inset-0 before:bg-neutral-back before:transition-colors before:duration-[120ms] before:ease-in-out before:rounded-none before:z-[1] after:content-[''] after:absolute after:inset-1 after:bg-neutral-front after:border after:border-neutral-border after:rounded-lg after:transition-colors after:duration-[120ms] after:ease-in-out after:z-[1] hover:before:bg-neutral-back-hover hover:after:bg-neutral-front-hover hover:after:border-neutral-border-hover group"
                onClick={toggleSettings}
              >
                <span className="absolute inset-1 rounded-lg bg-white/28 origin-left z-[2] pointer-events-none animate-dwell-fill" aria-hidden="true" />
                <span className="relative z-[3] inline-flex items-center gap-2 leading-none">{isSettingsOpen ? 'Close Settings' : 'Settings'}</span>
              </button>
              <button
                className="relative h-14 px-4 rounded-none border-none bg-transparent text-base cursor-pointer overflow-hidden text-white before:content-[''] before:absolute before:inset-0 before:bg-primary-back before:transition-colors before:duration-[120ms] before:ease-in-out before:rounded-none before:z-[1] after:content-[''] after:absolute after:inset-1 after:bg-gradient-to-br after:from-primary-gradient-start after:to-primary-gradient-end after:border after:border-primary-border after:rounded-lg after:transition-all after:duration-[120ms] after:ease-in-out after:z-[1] hover:before:bg-primary-back-hover hover:after:from-primary-gradient-start-hover hover:after:to-primary-gradient-end-hover hover:after:border-primary-border-hover group"
                onClick={handleSpeak}
                onMouseEnter={() => handleDwell(() => handleSpeak())}
                onMouseLeave={handleDwellLeave}
              >
                <span className="absolute inset-1 rounded-lg bg-white/28 origin-left z-[2] pointer-events-none animate-dwell-fill" aria-hidden="true" />
                <span className="relative z-[3] inline-flex items-center gap-2 leading-none">
                  <svg
                    className="w-6 h-6 block"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    stroke="currentColor"
                    strokeWidth="2.25"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="9" cy="12" r="5" />
                    <path d="M17 10c1.75 1.75 1.75 3.5 0 5" />
                    <path d="M20 8c2.75 2.75 2.75 7.25 0 10" />
                  </svg>
                  Speak
                </span>
              </button>
            </div>
          </div>

          {isSettingsOpen && (
            <Settings
              initialDwellTime={dwellTime}
              onDwellTimeChange={handleDwellTimeChange}
            />
          )}

          {/* Main layout with plugins */}
          <Layout>
            {/* Suggestions Plugin */}
            <Layout.Panel name="suggestions" title="Suggestions">
              {suggestionsContext && SuggestionsPlugin.Component && (
                <SuggestionsPlugin.Component
                  context={suggestionsContext}
                  panelState="expanded"
                  onTogglePanel={() => {}}
                />
              )}
            </Layout.Panel>

            {/* Keyboard */}
            <Layout.Panel name="keyboard" title="Keyboard">
              <Keyboard onDwell={handleDwell} onDwellLeave={handleDwellLeave} />
            </Layout.Panel>

            {/* Hints Plugin */}
            <Layout.Panel name="hints" title="Hints">
              {hintsContext && HintsPlugin.Component && (
                <HintsPlugin.Component
                  context={hintsContext}
                  panelState="expanded"
                  onTogglePanel={() => {}}
                />
              )}
            </Layout.Panel>
          </Layout>

          {/* Speech warning modal */}
          <SpeechWarningModal ref={speechWarningModalRef} onSpeechEnabled={() => {
            setCurrentText('');
            setKeyboardPrefix('');
            setSelectedHints([]);
          }} />

          {/* Toast notification */}
          <Toast
            message={toastMessage}
            onClose={() => setToastMessage('')}
          />
        </div>
      </div>
    </div>
  );
};

export default App;
