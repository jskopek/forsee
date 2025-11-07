import React, { useState, useEffect, useMemo } from 'react';

const Suggestions = ({ text, onTextChange, dwellTime, conversationId, onSpeak }) => {
  const [suggestions, setSuggestions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hoveredSuggestion, setHoveredSuggestion] = useState(null);
  const hoverTimerRef = React.useRef(null);

  // Fetch suggestions from API when conversationId is available and component is mounted
  useEffect(() => {
    if (!conversationId) {
      setSuggestions([]);
      setError('No conversation ID provided');
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
        setSuggestions(data.suggestions || []);
      } catch (err) {
        console.error('Error fetching suggestions:', err);
        setError(err.message);
        setSuggestions([]);
      } finally {
        setIsLoading(false);
      }
    }, 300);

    return () => clearTimeout(debounceTimer);
  }, [conversationId, text]);

  // Calculate optimal grid layout
  const gridConfig = useMemo(() => {
    const suggestionCount = suggestions.length;
    if (suggestionCount === 0) return { cols: 1, rows: 1, itemsInLastRow: 0, lastRowIsIncomplete: false };
    // Try to create a roughly square grid
    const cols = Math.ceil(Math.sqrt(suggestionCount));
    const rows = Math.ceil(suggestionCount / cols);
    const itemsInLastRow = suggestionCount % cols || cols;
    const lastRowIsIncomplete = itemsInLastRow < cols;
    return { cols, rows, itemsInLastRow, lastRowIsIncomplete };
  }, [suggestions]);

  const applySuggestion = (suggestion) => {
    // Replace the text input with the suggestion, then trigger speak with the suggestion text
    onTextChange(suggestion);
    // Call speak with the suggestion text directly to avoid race conditions
    if (onSpeak) {
      onSpeak(suggestion);
    }
  };

  const handleSuggestionHover = (suggestion) => {
    setHoveredSuggestion(suggestion);
    
    // Immediately replace the text input with the suggestion
    onTextChange(suggestion);
    
    // Clear any existing timer
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }

    // Trigger speak after dwell time, passing the suggestion text directly
    hoverTimerRef.current = setTimeout(() => {
      if (onSpeak) {
        onSpeak(suggestion);
      }
    }, dwellTime);
  };

  const handleSuggestionLeave = () => {
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
            const isHovered = hoveredSuggestion === suggestion;
            
            // Check if this item is in the last row
            const rowIndex = Math.floor(index / gridConfig.cols);
            const isInLastRow = rowIndex === gridConfig.rows - 1;
            
            // Calculate column span for last row items if incomplete
            let gridColumnSpan = 1;
            if (isInLastRow && gridConfig.lastRowIsIncomplete) {
              // Distribute columns evenly among last row items
              gridColumnSpan = Math.floor(gridConfig.cols / gridConfig.itemsInLastRow);
              // Handle remainder by adding extra span to first items
              const remainder = gridConfig.cols % gridConfig.itemsInLastRow;
              const positionInLastRow = index - (gridConfig.rows - 1) * gridConfig.cols;
              if (positionInLastRow < remainder) {
                gridColumnSpan += 1;
              }
            }
            
            return (
              <button
                key={`${suggestion}-${index}`}
                className="relative flex flex-col items-center justify-center w-full h-full border-none outline-none bg-transparent text-white text-xl cursor-pointer overflow-hidden before:content-[''] before:absolute before:inset-0 before:bg-key-back before:transition-colors before:duration-[120ms] before:ease-in-out before:z-[1] after:content-[''] after:absolute after:inset-1 after:bg-key-front after:border after:border-key-border after:rounded-lg after:transition-colors after:duration-[120ms] after:ease-in-out after:z-[1] hover:before:bg-key-back-hover hover:after:bg-key-front-hover hover:after:border-key-border-hover group"
                style={{
                  gridColumn: `span ${gridColumnSpan}`,
                }}
                onMouseEnter={() => handleSuggestionHover(suggestion)}
                onMouseLeave={handleSuggestionLeave}
                onClick={() => applySuggestion(suggestion)}
              >
                <span
                  className={`absolute inset-1 rounded-lg bg-white/28 origin-left z-[2] pointer-events-none ${
                    isHovered ? 'animate-dwell-fill' : ''
                  }`}
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

