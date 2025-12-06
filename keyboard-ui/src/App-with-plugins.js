import React, { useState, useEffect, useRef, useMemo } from 'react';
import Pusher from 'pusher-js';
import Keyboard from './components/Keyboard';
import Settings from './components/Settings';
import SpeechWarningModal from './components/SpeechWarningModal';
import Backspace from './components/Backspace';
import Toast from './components/Toast';
import Layout from './components/Layout';
import PluginManager from './plugins/PluginManager';
import SuggestionsPlugin from './plugins/SuggestionsPlugin';

const App = () => {
  const [currentText, setCurrentText] = useState('');
  const [keyboardPrefix, setKeyboardPrefix] = useState('');
  const [selectedHints, setSelectedHints] = useState([]);
  const [dwellTime, setDwellTime] = useState(1000);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const speechWarningModalRef = useRef(null);
  const backspaceRef = useRef(null);

  // Toast state
  const [toastMessage, setToastMessage] = useState('');

  const keyPressTimer = useRef(null);
  const pusherRef = useRef(null);

  // Extract conversation ID from URL
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const conversationIdParam = urlParams.get('id');
    if (conversationIdParam) {
      setConversationId(conversationIdParam);
    }
  }, []);

  // Load dwell time from localStorage
  useEffect(() => {
    const savedDwellTime = localStorage.getItem('dwellTime');
    if (savedDwellTime) {
      setDwellTime(parseInt(savedDwellTime, 10));
    }
  }, []);

  // Initialize Pusher for message_added events
  useEffect(() => {
    if (!conversationId) return;

    const pusherKey = process.env.REACT_APP_PUSHER_KEY;
    const pusherCluster = process.env.REACT_APP_PUSHER_CLUSTER || 'us2';

    if (!pusherKey) return;

    console.log('[App] Connecting to Pusher...');
    const pusher = new Pusher(pusherKey, {
      cluster: pusherCluster,
    });

    const channel = pusher.subscribe(`conversation-${conversationId}`);

    channel.bind('message_added', (data) => {
      console.log('[App] Message added event:', data);
      // PluginManager will notify plugins
      if (pluginManagerRef.current) {
        pluginManagerRef.current.notifyMessageAdded();
      }
    });

    pusherRef.current = pusher;

    return () => {
      console.log('[App] Disconnecting from Pusher');
      pusher.unsubscribe(`conversation-${conversationId}`);
      pusher.disconnect();
    };
  }, [conversationId]);

  // Create PluginManager
  const pluginManagerRef = useRef(null);

  useEffect(() => {
    if (!conversationId) return;

    // Create plugin manager
    const manager = new PluginManager(conversationId, pusherRef.current);

    // Set up state getters
    manager.setStateGetters({
      getCurrentText: () => currentText,
      getKeyboardPrefix: () => keyboardPrefix,
      getSelectedHints: () => selectedHints,
      getDwellTime: () => dwellTime,
      speak: handleSpeak,
      addMessage: handleAddMessage,
    });

    // Register plugins
    manager.register(SuggestionsPlugin);

    // Mount plugins
    manager.mountAll();

    pluginManagerRef.current = manager;

    return () => {
      manager.unmountAll();
    };
  }, [conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleKeyPress = (key) => {
    const charToAdd = key === 'space' ? ' ' : key;
    setKeyboardPrefix((prev) => {
      const nextValue = prev + charToAdd;
      setCurrentText(nextValue);
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

  const handleHintToggle = (word, isSelected) => {
    setSelectedHints((prev) => {
      const normalizedWord = word.toLowerCase();
      if (isSelected) {
        return prev.filter((hint) => hint.toLowerCase() !== normalizedWord);
      }
      if (prev.some((hint) => hint.toLowerCase() === normalizedWord)) {
        return prev;
      }
      return [...prev, word];
    });
  };

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

  const handleSpeak = async (textToSpeak) => {
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
  };

  const handleAddMessage = async (body, sender = 'user') => {
    if (!conversationId) return;

    try {
      const apiBaseUrl = process.env.REACT_APP_API_BASE_URL ||
                         window.API_BASE_URL ||
                         (process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : '');

      const response = await fetch(`${apiBaseUrl}/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ body, sender }),
      });

      if (!response.ok) {
        throw new Error('Failed to send message');
      }
    } catch (err) {
      console.error('Error sending message:', err);
      setToastMessage('Failed to send message');
    }
  };

  const handleDwellTimeChange = (newDwellTime) => {
    setDwellTime(newDwellTime);
    localStorage.setItem('dwellTime', newDwellTime);
  };

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

  // Get plugin context for rendering
  const pluginContext = useMemo(() => {
    if (!pluginManagerRef.current) return null;
    return pluginManagerRef.current.buildContext('builtin.suggestions');
  }, [conversationId, currentText, keyboardPrefix, selectedHints, dwellTime]);

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
              {pluginContext && SuggestionsPlugin.Component && (
                <SuggestionsPlugin.Component
                  context={pluginContext}
                  panelState="expanded"
                  onTogglePanel={() => {}}
                />
              )}
            </Layout.Panel>

            {/* Keyboard */}
            <Layout.Panel name="keyboard" title="Keyboard">
              <Keyboard onDwell={handleDwell} onDwellLeave={handleDwellLeave} />
            </Layout.Panel>

            {/* Hints - keeping old component for now */}
            <Layout.Panel name="hints" title="Hints">
              <div className="flex-[2] flex flex-col p-0 relative min-h-0">
                <div className="flex-1 flex items-center justify-center bg-bg-main">
                  <div className="text-white text-lg">Hints plugin coming soon...</div>
                </div>
              </div>
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
