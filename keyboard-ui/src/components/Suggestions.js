import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';

const Suggestions = ({ prefix = '', hintText = '', dwellTime, conversationId, onSpeak, onShowToast, onRegisterRefresh, onLoadingChange, onTextChange }) => {
  const [suggestions, setSuggestions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const hoverTimerRef = useRef(null);
  const isHoveringRef = useRef(false);
  const containerHoverRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const lastFetchedPrefixRef = useRef('');
  const lastFetchedHintRef = useRef('');
  const prefixRef = useRef(prefix);
  const hintTextRef = useRef(hintText);

  useEffect(() => {
    prefixRef.current = prefix;
  }, [prefix]);

  useEffect(() => {
    hintTextRef.current = hintText;
  }, [hintText]);

  const fetchSuggestions = useCallback(async () => {
    console.log('[Suggestions] 🔍 Fetching suggestions...');
    if (!conversationId) {
      setSuggestions([]);
      setError('No conversation ID provided');
      return;
    }

    // Skip API calls if we're currently hovering over a suggestion
    if (containerHoverRef.current) {
      console.log('[Suggestions] ⏸️ Skipping fetch - currently hovering');
      return;
    }

    setIsLoading(true);
    if (onLoadingChange) onLoadingChange(true);
    setError(null);
    
    const prefixPayload = prefixRef.current.trim();
    const hintPayload = hintTextRef.current.trim();

    try {
      const apiBaseUrl = process.env.REACT_APP_API_BASE_URL || window.API_BASE_URL || (process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : '');
      const response = await fetch(`${apiBaseUrl}/api/conversations/${conversationId}/suggestions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          hint: hintPayload || null,
          prefix: prefixPayload || null,
        }),
      });

      if (!response.ok) {
        throw new Error(response.status === 401 || response.status === 403 ? 'Authentication required' : response.status === 404 ? 'Conversation not found' : 'Request failed');
      }

      const data = await response.json();
      console.log('[Suggestions] ✅ Received suggestions:', data.suggestions?.length || 0);
      
      // Track the prefix and hints that were used for this fetch
      lastFetchedPrefixRef.current = prefixPayload;
      lastFetchedHintRef.current = hintPayload;
      
      // Only update suggestions if we're not hovering (to avoid replacing suggestions while user is selecting)
      if (!containerHoverRef.current) {
        setSuggestions(data.suggestions || []);
      } else {
        console.log('[Suggestions] ⏸️ Not updating - hover detected during fetch');
      }
    } catch (err) {
      console.error('[Suggestions] ❌ Error fetching suggestions:', err);
      setError(err.message);
      if (!containerHoverRef.current) {
        setSuggestions([]);
      }
    } finally {
      setIsLoading(false);
      if (onLoadingChange) onLoadingChange(false);
    }
  }, [conversationId, onLoadingChange]);

  // Fetch suggestions from API when conversationId is available and component is mounted
  useEffect(() => {
    if (!conversationId) {
      setSuggestions([]);
      setError('No conversation ID provided');
      return;
    }

    // Debounce API calls to avoid excessive requests while typing
    const debounceTimer = setTimeout(() => {
      fetchSuggestions();
    }, 300);

    return () => {
      clearTimeout(debounceTimer);
    };
  }, [conversationId, prefix, hintText, fetchSuggestions]);

  // Calculate grid layout - always use a single column
  const gridConfig = useMemo(() => {
    const suggestionCount = suggestions.length;
    if (suggestionCount === 0) return { cols: 1, rows: 1 };
    // Always display suggestions in a single column
    return { cols: 1, rows: suggestionCount };
  }, [suggestions]);

  const applySuggestion = (suggestion) => {
    isHoveringRef.current = false;
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }

    onTextChange(suggestion);
    if (onSpeak) {
      onSpeak(suggestion);
    }
  };

  const handleSuggestionHover = (suggestion) => {
    isHoveringRef.current = true;

    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }

    hoverTimerRef.current = setTimeout(() => {
      onTextChange(suggestion);
      if (onSpeak) {
        onSpeak(suggestion);
      }
    }, dwellTime);
  };

  const handleSuggestionLeave = () => {
    isHoveringRef.current = false;

    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const handleContainerMouseEnter = () => {
    console.log('[Suggestions] 🖱️ Container hover started');
    containerHoverRef.current = true;
  };

  const handleContainerMouseLeave = () => {
    console.log('[Suggestions] 🖱️ Container hover ended');
    containerHoverRef.current = false;
    isHoveringRef.current = false;
    
    const currentPrefix = prefixRef.current.trim();
    const currentHint = hintTextRef.current.trim();
    if (
      currentPrefix !== lastFetchedPrefixRef.current ||
      currentHint !== lastFetchedHintRef.current
    ) {
      console.log('[Suggestions] 🔄 Prefix/hint changed while hovering, refetching suggestions');
      console.log('[Suggestions]   Previous prefix:', lastFetchedPrefixRef.current);
      console.log('[Suggestions]   Current prefix:', currentPrefix);
      console.log('[Suggestions]   Previous hints:', lastFetchedHintRef.current);
      console.log('[Suggestions]   Current hints:', currentHint);
      fetchSuggestions();
    } else if (pendingRefreshRef.current) {
      // If there's a pending refresh (from new message), do it now
      console.log('[Suggestions] 🔄 Executing pending refresh');
      pendingRefreshRef.current = false;
      fetchSuggestions();
    }
  };

  // Register refresh callback with parent
  useEffect(() => {
    if (onRegisterRefresh) {
      const refreshHandler = () => {
        console.log('[Suggestions] 🔄 Refresh handler called');
        // Check if we're currently hovering
        if (containerHoverRef.current) {
          console.log('[Suggestions] ⏸️ Currently hovering, queueing refresh');
          // Queue refresh for when hover ends
          pendingRefreshRef.current = true;
          if (onShowToast) {
            onShowToast('New suggestions available - will update when you move away');
          }
        } else {
          console.log('[Suggestions] ✅ Not hovering, refreshing immediately');
          // Refresh immediately
          fetchSuggestions();
        }
      };
      
      console.log('[Suggestions] 📝 Registering refresh handler');
      onRegisterRefresh(refreshHandler);
      
      return () => {
        console.log('[Suggestions] 🧹 Unregistering refresh handler');
        if (onRegisterRefresh) {
          onRegisterRefresh(null);
        }
      };
    }
  }, [onRegisterRefresh, onShowToast, fetchSuggestions]);

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
      {error && !isLoading && (
        <div className="flex-1 flex items-center justify-center bg-yellow-600/90 text-white px-4 py-2">
          <div className="text-lg">{error}</div>
        </div>
      )}
      {suggestions.length === 0 && !error && (
        <div className="flex-1 flex items-center justify-center bg-bg-main">
          <div className="text-white text-lg">No suggestions available</div>
        </div>
      )}
      {suggestions.length > 0 && (
        <div
          className="flex-1 grid"
          style={{
            gridTemplateColumns: `repeat(${gridConfig.cols}, 1fr)`,
            gridTemplateRows: `repeat(${gridConfig.rows}, 1fr)`,
          }}
        >
          {suggestions.map((suggestion, index) => {
            return (
              <button
                key={`${suggestion}-${index}`}
                className="relative flex flex-col items-center justify-center w-full h-full border-none outline-none bg-transparent text-white text-xl cursor-pointer overflow-hidden before:content-[''] before:absolute before:inset-0 before:bg-key-back before:transition-colors before:duration-[120ms] before:ease-in-out before:z-[1] after:content-[''] after:absolute after:inset-1 after:bg-key-front after:border after:border-key-border after:rounded-lg after:transition-colors after:duration-[120ms] after:ease-in-out after:z-[1] hover:before:bg-key-back-hover hover:after:bg-key-front-hover hover:after:border-key-border-hover group"
                onMouseEnter={() => handleSuggestionHover(suggestion)}
                onMouseLeave={handleSuggestionLeave}
                onClick={() => applySuggestion(suggestion)}
              >
                <span
                  className="absolute inset-1 rounded-lg bg-white/28 origin-left z-[2] pointer-events-none animate-dwell-fill"
                  aria-hidden="true"
                />
                <span className="relative z-[3] font-semibold text-center px-4 break-words">
                  {suggestion}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default Suggestions;

