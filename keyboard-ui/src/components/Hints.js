import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';

const Hints = ({ text, onTextChange, dwellTime, conversationId, onShowToast, onHintSelected, onRegisterRefresh }) => {
  const [hints, setHints] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hoveredHint, setHoveredHint] = useState(null);
  const hoverTimerRef = useRef(null);
  const containerHoverRef = useRef(false);
  const textRef = useRef(text);
  const pendingRefreshRef = useRef(false);

  // Keep textRef in sync with text prop
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  const fetchHints = useCallback(async () => {
    console.log('[Hints] 🔍 Fetching hints...');
    if (!conversationId) {
      setHints([]);
      setError('No conversation ID provided');
      return;
    }

    // Skip API calls if we're currently hovering
    if (containerHoverRef.current) {
      console.log('[Hints] ⏸️ Skipping fetch - currently hovering');
      return;
    }

    setIsLoading(true);
    setError(null);
    
    try {
      const apiBaseUrl = process.env.REACT_APP_API_BASE_URL || window.API_BASE_URL || (process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : '');
      const response = await fetch(`${apiBaseUrl}/api/conversations/${conversationId}/hints`, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(response.status === 401 || response.status === 403 ? 'Authentication required' : response.status === 404 ? 'Conversation not found' : 'Request failed');
      }

      const data = await response.json();
      console.log('[Hints] ✅ Received hints:', data.hints?.length || 0);
      if (!containerHoverRef.current) {
        setHints(data.hints || []);
      } else {
        console.log('[Hints] ⏸️ Not updating - hover detected during fetch');
      }
    } catch (err) {
      console.error('[Hints] ❌ Error fetching hints:', err);
      setError(err.message);
      if (!containerHoverRef.current) {
        setHints([]);
      }
    } finally {
      setIsLoading(false);
    }
  }, [conversationId]);

  // Fetch hints from API when conversationId is available
  useEffect(() => {
    if (!conversationId) {
      setHints([]);
      setError('No conversation ID provided');
      return;
    }

    fetchHints();
  }, [conversationId, fetchHints]);

  // Calculate which hints are currently in the text
  const selectedHints = useMemo(() => {
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    return new Set(words);
  }, [text]);

  // Calculate optimal grid layout
  const gridConfig = useMemo(() => {
    const hintCount = hints.length;
    // Try to create a roughly square grid
    const cols = Math.ceil(Math.sqrt(hintCount));
    const rows = Math.ceil(hintCount / cols);
    const itemsInLastRow = hintCount % cols || cols;
    const lastRowIsIncomplete = itemsInLastRow < cols;
    return { cols, rows, itemsInLastRow, lastRowIsIncomplete };
  }, [hints]);

  const addHint = (word, currentText) => {
    const trimmedText = currentText.trim();
    if (trimmedText) {
      onTextChange(trimmedText + ' ' + word + ' ');
    } else {
      onTextChange(word + ' ');
    }
  };

  const removeHint = (word, currentText) => {
    const words = currentText.trim().split(/\s+/);
    const filteredWords = words.filter(w => w.toLowerCase() !== word.toLowerCase());
    onTextChange(filteredWords.join(' ') + (filteredWords.length > 0 ? ' ' : ''));
  };

  const handleHintHover = (hint) => {
    setHoveredHint(hint);
    
    // Clear any existing timer
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }

    const isSelected = selectedHints.has(hint.word.toLowerCase());
    
    if (isSelected) {
      // If selected, remove on hover after dwell time
      hoverTimerRef.current = setTimeout(() => {
        removeHint(hint.word, textRef.current);
      }, dwellTime);
    } else {
      // If not selected, add on hover after dwell time
      hoverTimerRef.current = setTimeout(() => {
        addHint(hint.word, textRef.current);
        // Switch to suggestions view after adding a hint
        if (onHintSelected) {
          onHintSelected();
        }
      }, dwellTime);
    }
  };

  const handleHintLeave = () => {
    setHoveredHint(null);
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const handleContainerMouseEnter = () => {
    console.log('[Hints] 🖱️ Container hover started');
    containerHoverRef.current = true;
  };

  const handleContainerMouseLeave = () => {
    console.log('[Hints] 🖱️ Container hover ended');
    containerHoverRef.current = false;
    
    // If there's a pending refresh, do it now
    if (pendingRefreshRef.current) {
      console.log('[Hints] 🔄 Executing pending refresh');
      pendingRefreshRef.current = false;
      fetchHints();
    }
  };

  // Register refresh callback with parent
  useEffect(() => {
    if (onRegisterRefresh) {
      const refreshHandler = () => {
        console.log('[Hints] 🔄 Refresh handler called');
        // Check if we're currently hovering
        if (containerHoverRef.current) {
          console.log('[Hints] ⏸️ Currently hovering, queueing refresh');
          // Queue refresh for when hover ends
          pendingRefreshRef.current = true;
          if (onShowToast) {
            onShowToast('New hints available - will update when you move away');
          }
        } else {
          console.log('[Hints] ✅ Not hovering, refreshing immediately');
          // Refresh immediately
          fetchHints();
        }
      };
      
      console.log('[Hints] 📝 Registering refresh handler');
      onRegisterRefresh(refreshHandler);
      
      return () => {
        console.log('[Hints] 🧹 Unregistering refresh handler');
        if (onRegisterRefresh) {
          onRegisterRefresh(null);
        }
      };
    }
  }, [onRegisterRefresh, onShowToast, fetchHints]);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);

  return (
    <div 
      className="flex-1 flex flex-col p-0 relative"
      onMouseEnter={handleContainerMouseEnter}
      onMouseLeave={handleContainerMouseLeave}
    >
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-main/80 z-10">
          <div className="text-white text-lg">Loading hints...</div>
        </div>
      )}
      {error && !isLoading && (
        <div className="absolute top-2 left-2 right-2 bg-yellow-600/90 text-white px-4 py-2 rounded text-sm z-10">
          {error}
        </div>
      )}
      {!isLoading && hints.length === 0 && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-main z-10">
          <div className="text-white text-lg">No hints available</div>
        </div>
      )}
      {hints.length > 0 && (
        <div
          className="flex-1 grid w-full h-full"
          style={{
            gridTemplateColumns: `repeat(${gridConfig.cols}, 1fr)`,
            gridTemplateRows: `repeat(${gridConfig.rows}, 1fr)`,
          }}
        >
          {hints.map((hint, index) => {
          const isSelected = selectedHints.has(hint.word.toLowerCase());
          const isHovered = hoveredHint?.word === hint.word;
          
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
              key={`${hint.word}-${index}`}
              className={`relative flex flex-col items-center justify-center w-full h-full border-none outline-none bg-transparent text-white text-xl cursor-pointer overflow-hidden before:content-[''] before:absolute before:inset-0 before:transition-colors before:duration-[120ms] before:ease-in-out before:z-[1] after:content-[''] after:absolute after:inset-1 after:border after:rounded-lg after:transition-all after:duration-[120ms] after:ease-in-out after:z-[1] group ${
                isSelected
                  ? 'before:bg-primary-back after:bg-gradient-to-br after:from-primary-gradient-start after:to-primary-gradient-end after:border-primary-border hover:before:bg-primary-back-hover hover:after:from-primary-gradient-start-hover hover:after:to-primary-gradient-end-hover hover:after:border-primary-border-hover'
                  : 'before:bg-key-back after:bg-key-front after:border-key-border hover:before:bg-key-back-hover hover:after:bg-key-front-hover hover:after:border-key-border-hover'
              }`}
              style={{
                gridColumn: `span ${gridColumnSpan}`,
              }}
              onMouseEnter={() => handleHintHover(hint)}
              onMouseLeave={handleHintLeave}
            >
              <span
                className="absolute inset-1 rounded-lg bg-white/28 origin-left z-[2] pointer-events-none animate-dwell-fill"
                aria-hidden="true"
              />
              <span className="relative z-[3] text-4xl mb-2">{hint.emoji}</span>
              <span className={`relative z-[3] font-semibold ${isSelected ? 'underline' : ''}`}>
                {hint.word}
              </span>
            </button>
          );
        })}
        </div>
      )}
    </div>
  );
};

export default Hints;

