import React, { useState, useEffect, useMemo } from 'react';

const Suggestions = ({ text, onTextChange, dwellTime, conversationId, onSpeak }) => {
  const [suggestions, setSuggestions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hoveredSuggestion, setHoveredSuggestion] = useState(null);
  const hoverTimerRef = React.useRef(null);
  const isHoveringRef = React.useRef(false);

  // Fetch suggestions from API when conversationId is available and component is mounted
  useEffect(() => {
    if (!conversationId) {
      setSuggestions([]);
      setError('No conversation ID provided');
      return;
    }

    // Skip API calls if we're currently hovering over a suggestion
    if (isHoveringRef.current) {
      return;
    }

    // Debounce API calls to avoid excessive requests while typing
    const debounceTimer = setTimeout(async () => {
      setIsLoading(true);
      setError(null);
      
      try {
        const apiBaseUrl = process.env.REACT_APP_API_BASE_URL || (process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : '');
        const response = await fetch(`${apiBaseUrl}/api/conversations/${conversationId}/suggestions`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ hint: text.trim() || null }),
        });

        if (!response.ok) {
          throw new Error(response.status === 401 || response.status === 403 ? 'Authentication required' : response.status === 404 ? 'Conversation not found' : 'Request failed');
        }

        const data = await response.json();
        
        // Only update suggestions if we're not hovering (to avoid replacing suggestions while user is selecting)
        if (!isHoveringRef.current) {
          setSuggestions(data.suggestions || []);
        }
      } catch (err) {
        console.error('Error fetching suggestions:', err);
        setError(err.message);
        if (!isHoveringRef.current) {
          setSuggestions([]);
        }
      } finally {
        setIsLoading(false);
      }
    }, 300);

    return () => {
      clearTimeout(debounceTimer);
    };
  }, [conversationId, text]);

  // Calculate grid layout - always use a single column
  const gridConfig = useMemo(() => {
    const suggestionCount = suggestions.length;
    if (suggestionCount === 0) return { cols: 1, rows: 1 };
    // Always display suggestions in a single column
    return { cols: 1, rows: suggestionCount };
  }, [suggestions]);

  const applySuggestion = (suggestion) => {
    isHoveringRef.current = false;
    setHoveredSuggestion(null);
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
    setHoveredSuggestion(suggestion);
    
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
    setHoveredSuggestion(null);
    
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
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
    <div className="flex-1 flex flex-col p-0 relative">
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-main/80 z-10">
          <div className="text-white text-lg">Loading suggestions...</div>
        </div>
      )}
      {error && !isLoading && (
        <div className="absolute top-2 left-2 right-2 bg-yellow-600/90 text-white px-4 py-2 rounded text-sm z-10">
          {error}
        </div>
      )}
      {!isLoading && suggestions.length === 0 && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-main z-10">
          <div className="text-white text-lg">No suggestions available</div>
        </div>
      )}
      {suggestions.length > 0 && (
        <div
          className="flex-1 grid w-full h-full"
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

