import React, { useState, useEffect, useRef, useCallback } from 'react';
import Pusher from 'pusher-js';
import Button from './Button';

const Suggestions = ({ prefix = '', hintText = '', dwellTime, conversationId, onSpeak, onShowToast, onRegisterRefresh, onLoadingChange, onTextChange }) => {
  const MAX_SUGGESTIONS = 6;

  // FIFO queue: newest suggestions push out oldest
  const [suggestions, setSuggestions] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const pusherRef = useRef(null);
  const containerHoverRef = useRef(false);
  const hoverTimerRef = useRef(null);
  const prefixRef = useRef(prefix);
  const hintTextRef = useRef(hintText);
  const lastFetchedPrefixRef = useRef('');
  const lastFetchedHintRef = useRef('');
  const pendingRefreshRef = useRef(false);

  useEffect(() => {
    prefixRef.current = prefix;
  }, [prefix]);

  useEffect(() => {
    hintTextRef.current = hintText;
  }, [hintText]);

  // Initialize Pusher
  useEffect(() => {
    if (!conversationId) return;

    const pusher = new Pusher(process.env.REACT_APP_PUSHER_KEY, {
      cluster: process.env.REACT_APP_PUSHER_CLUSTER
    });

    const channel = pusher.subscribe(`conversation-${conversationId}`);

    channel.bind('suggestion_ready', (data) => {
      console.log(`[Suggestions] Received: ${data.data}`);

      setSuggestions(prev => {
        // FIFO: Add new to end, remove from start if > MAX
        const updated = [...prev, data.data];
        if (updated.length > MAX_SUGGESTIONS) {
          return updated.slice(-MAX_SUGGESTIONS); // Keep last 6
        }
        return updated;
      });
    });

    channel.bind('suggestion_ready_complete', (data) => {
      console.log(`[Suggestions] Streaming complete: ${data.count} suggestions`);
      setIsStreaming(false);
      if (onLoadingChange) onLoadingChange(false);
    });

    channel.bind('suggestion_ready_error', (data) => {
      console.error('[Suggestions] Error:', data.error);
      setIsStreaming(false);
      if (onLoadingChange) onLoadingChange(false);
      if (onShowToast) onShowToast(`Error: ${data.error}`);
    });

    pusherRef.current = pusher;
    return () => {
      pusher.unsubscribe(`conversation-${conversationId}`);
      pusher.disconnect();
    };
  }, [conversationId, onLoadingChange, onShowToast]);

  const fetchSuggestions = useCallback(async () => {
    if (!conversationId || containerHoverRef.current) {
      console.log('[Suggestions] Skipping fetch - no conversationId or hovering');
      return;
    }

    // Clear existing and start streaming
    console.log('[Suggestions] Starting new stream');
    setSuggestions([]);
    setIsStreaming(true);
    if (onLoadingChange) onLoadingChange(true);

    const apiBaseUrl = process.env.REACT_APP_API_BASE_URL ||
                       window.API_BASE_URL ||
                       (process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : '');

    const prefixPayload = prefixRef.current.trim();
    const hintPayload = hintTextRef.current.trim();

    // Track what we're fetching
    lastFetchedPrefixRef.current = prefixPayload;
    lastFetchedHintRef.current = hintPayload;

    try {
      const response = await fetch(
        `${apiBaseUrl}/api/conversations/${conversationId}/suggestions/stream`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hint: hintPayload || null,
            prefix: prefixPayload || null
          })
        }
      );

      if (!response.ok) {
        throw new Error('Failed to start streaming');
      }

      console.log('[Suggestions] Streaming request sent successfully');
    } catch (err) {
      console.error('[Suggestions] Error:', err);
      setIsStreaming(false);
      if (onLoadingChange) onLoadingChange(false);
      if (onShowToast) onShowToast('Failed to load suggestions');
    }
  }, [conversationId, onLoadingChange, onShowToast]);

  // Auto-fetch on mount and when prefix/hint changes
  useEffect(() => {
    if (!conversationId) return;

    const debounceTimer = setTimeout(() => {
      fetchSuggestions();
    }, 300);

    return () => clearTimeout(debounceTimer);
  }, [conversationId, prefix, hintText, fetchSuggestions]);

  // Register refresh callback
  useEffect(() => {
    if (onRegisterRefresh) {
      const refreshHandler = () => {
        console.log('[Suggestions] Refresh handler called');
        if (containerHoverRef.current) {
          console.log('[Suggestions] Currently hovering, queueing refresh');
          pendingRefreshRef.current = true;
          if (onShowToast) {
            onShowToast('New suggestions available - will update when you move away');
          }
        } else {
          console.log('[Suggestions] Not hovering, refreshing immediately');
          fetchSuggestions();
        }
      };

      console.log('[Suggestions] Registering refresh handler');
      onRegisterRefresh(refreshHandler);

      return () => {
        console.log('[Suggestions] Unregistering refresh handler');
        if (onRegisterRefresh) {
          onRegisterRefresh(null);
        }
      };
    }
  }, [onRegisterRefresh, onShowToast, fetchSuggestions]);

  const applySuggestion = (suggestion) => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    onTextChange(suggestion);
    if (onSpeak) onSpeak(suggestion);
  };

  const handleSuggestionHover = (suggestion) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);

    hoverTimerRef.current = setTimeout(() => {
      applySuggestion(suggestion);
    }, dwellTime);
  };

  const handleSuggestionLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const handleContainerMouseEnter = () => {
    console.log('[Suggestions] Container hover started');
    containerHoverRef.current = true;
  };

  const handleContainerMouseLeave = () => {
    console.log('[Suggestions] Container hover ended');
    containerHoverRef.current = false;

    const currentPrefix = prefixRef.current.trim();
    const currentHint = hintTextRef.current.trim();
    if (
      currentPrefix !== lastFetchedPrefixRef.current ||
      currentHint !== lastFetchedHintRef.current
    ) {
      console.log('[Suggestions] Prefix/hint changed while hovering, refetching suggestions');
      fetchSuggestions();
    } else if (pendingRefreshRef.current) {
      console.log('[Suggestions] Executing pending refresh');
      pendingRefreshRef.current = false;
      fetchSuggestions();
    }
  };

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);

  return (
    <div
      className="flex-[2] flex flex-col p-0 relative min-h-0"
      onMouseEnter={handleContainerMouseEnter}
      onMouseLeave={handleContainerMouseLeave}
    >
      {suggestions.length === 0 && !isStreaming && (
        <div className="flex-1 flex items-center justify-center bg-bg-main">
          <div className="text-white text-lg">No suggestions available</div>
        </div>
      )}

      {(suggestions.length > 0 || isStreaming) && (
        <div className="flex-1 grid grid-cols-1" style={{ gridTemplateRows: `repeat(${MAX_SUGGESTIONS}, 1fr)` }}>
          {/* Show suggestions as they arrive, with placeholders for empty slots */}
          {Array.from({ length: MAX_SUGGESTIONS }, (_, index) => {
            const suggestion = suggestions[index];

            return suggestion ? (
              <Button
                key={`${suggestion}-${index}`}
                label={suggestion}
                color="green"
                dwell={false}
                loading={false}
                onMouseEnter={() => handleSuggestionHover(suggestion)}
                onMouseLeave={handleSuggestionLeave}
                onClick={() => applySuggestion(suggestion)}
                className="text-xl text-center px-4 break-words"
              />
            ) : isStreaming ? (
              <Button
                key={`skeleton-${index}`}
                loading={true}
              />
            ) : null;
          })}
        </div>
      )}
    </div>
  );
};

export default Suggestions;
