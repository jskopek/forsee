import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import Pusher from 'pusher-js';
import Button from './Button';

const Hints = ({ selectedHints = [], onHintToggle, dwellTime, conversationId, onShowToast, onRegisterRefresh, onLoadingChange }) => {
  const MAX_HINTS = 19; // Reserve one slot for "More" button

  // FIFO queue: newest hints push out oldest
  const [hints, setHints] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const pusherRef = useRef(null);
  const hoverTimerRef = useRef(null);
  const containerHoverRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const selectedHintsSet = useMemo(() => new Set(selectedHints.map((word) => word.toLowerCase())), [selectedHints]);

  // Auto-unselect hints that are no longer in the list
  useEffect(() => {
    if (hints.length === 0 || selectedHints.length === 0) return;

    const currentHintWords = new Set(hints.map(h => h.word.toLowerCase()));
    const hintsToRemove = selectedHints.filter(hint => !currentHintWords.has(hint.toLowerCase()));

    if (hintsToRemove.length > 0) {
      console.log('[Hints] Auto-unselecting hints no longer in list:', hintsToRemove);
      hintsToRemove.forEach(hint => {
        // Unselect each hint that's no longer available
        if (onHintToggle) {
          onHintToggle(hint, true); // true means it's currently selected, so toggle it off
        }
      });
    }
  }, [hints, selectedHints, onHintToggle]);

  // Initialize Pusher
  useEffect(() => {
    if (!conversationId) return;

    const pusher = new Pusher(process.env.REACT_APP_PUSHER_KEY, {
      cluster: process.env.REACT_APP_PUSHER_CLUSTER
    });

    const channel = pusher.subscribe(`conversation-${conversationId}`);

    channel.bind('hint_ready', (data) => {
      console.log(`[Hints] Received: ${data.data.word}`);

      setHints(prev => {
        // FIFO: Add new to end, remove from start if > MAX
        const updated = [...prev, data.data];
        if (updated.length > MAX_HINTS) {
          return updated.slice(-MAX_HINTS); // Keep last 20
        }
        return updated;
      });
    });

    channel.bind('hint_ready_complete', (data) => {
      console.log(`[Hints] Streaming complete: ${data.count} hints`);
      setIsStreaming(false);
      if (onLoadingChange) onLoadingChange(false);
    });

    channel.bind('hint_ready_error', (data) => {
      console.error('[Hints] Error:', data.error);
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

  const fetchHints = useCallback(async (excludeWords = [], forceRefresh = false) => {
    // Skip if hovering UNLESS it's a forced refresh (from "More" button)
    if (!conversationId || (containerHoverRef.current && !forceRefresh)) {
      console.log('[Hints] Skipping fetch - no conversationId or hovering');
      return;
    }

    // Clear existing and start streaming
    console.log('[Hints] Starting new stream', excludeWords.length > 0 ? `(excluding ${excludeWords.length} hints)` : '');
    setHints([]);
    setIsStreaming(true);
    if (onLoadingChange) onLoadingChange(true);

    const apiBaseUrl = process.env.REACT_APP_API_BASE_URL ||
                       window.API_BASE_URL ||
                       (process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : '');

    try {
      const response = await fetch(
        `${apiBaseUrl}/api/conversations/${conversationId}/hints/stream`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exclude_words: excludeWords
          })
        }
      );

      if (!response.ok) {
        throw new Error('Failed to start streaming');
      }

      console.log('[Hints] Streaming request sent successfully');
    } catch (err) {
      console.error('[Hints] Error:', err);
      setIsStreaming(false);
      if (onLoadingChange) onLoadingChange(false);
      if (onShowToast) onShowToast('Failed to load hints');
    }
  }, [conversationId, onLoadingChange, onShowToast]);

  // Auto-fetch on mount
  useEffect(() => {
    if (!conversationId) return;

    fetchHints();
  }, [conversationId, fetchHints]);

  // Register refresh callback
  useEffect(() => {
    if (onRegisterRefresh) {
      const refreshHandler = () => {
        console.log('[Hints] Refresh handler called');
        if (containerHoverRef.current) {
          console.log('[Hints] Currently hovering, queueing refresh');
          pendingRefreshRef.current = true;
          if (onShowToast) {
            onShowToast('New hints available - will update when you move away');
          }
        } else {
          console.log('[Hints] Not hovering, refreshing immediately');
          fetchHints();
        }
      };

      console.log('[Hints] Registering refresh handler');
      onRegisterRefresh(refreshHandler);

      return () => {
        console.log('[Hints] Unregistering refresh handler');
        if (onRegisterRefresh) {
          onRegisterRefresh(null);
        }
      };
    }
  }, [onRegisterRefresh, onShowToast, fetchHints]);

  // Calculate optimal grid layout (including "More" button)
  const gridConfig = useMemo(() => {
    // Add 1 for the "More" button
    const totalItems = hints.length + 1;
    // Try to create a roughly square grid
    const cols = Math.ceil(Math.sqrt(totalItems));
    const rows = Math.ceil(totalItems / cols);
    const itemsInLastRow = totalItems % cols || cols;
    const lastRowIsIncomplete = itemsInLastRow < cols;
    return { cols, rows, itemsInLastRow, lastRowIsIncomplete };
  }, [hints]);

  const handleHintHover = (hint) => {
    // Clear any existing timer
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }

    const normalized = hint.word.toLowerCase();
    const isSelected = selectedHintsSet.has(normalized);

    hoverTimerRef.current = setTimeout(() => {
      if (onHintToggle) {
        onHintToggle(hint.word, isSelected);
      }
    }, dwellTime);
  };

  const handleHintLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const handleMoreHover = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }

    hoverTimerRef.current = setTimeout(() => {
      // Get all current hint words to exclude
      const currentWords = hints.map(h => h.word);
      console.log('[Hints] "More" button activated - fetching new hints excluding:', currentWords);
      fetchHints(currentWords, true); // Force refresh even while hovering
    }, dwellTime);
  };

  const handleContainerMouseEnter = () => {
    console.log('[Hints] Container hover started');
    containerHoverRef.current = true;
  };

  const handleContainerMouseLeave = () => {
    console.log('[Hints] Container hover ended');
    containerHoverRef.current = false;

    // If there's a pending refresh, do it now
    if (pendingRefreshRef.current) {
      console.log('[Hints] Executing pending refresh');
      pendingRefreshRef.current = false;
      fetchHints();
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
      {hints.length === 0 && !isStreaming && (
        <div className="flex-1 flex items-center justify-center bg-bg-main">
          <div className="text-white text-lg">No hints available</div>
        </div>
      )}
      {hints.length > 0 && (
        <div
          className="flex-1 grid"
          style={{
            gridTemplateColumns: `repeat(${gridConfig.cols}, 1fr)`,
            gridTemplateRows: `repeat(${gridConfig.rows}, 1fr)`,
          }}
        >
          {hints.map((hint, index) => {
          const isSelected = selectedHintsSet.has(hint.word.toLowerCase());

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
            <Button
              key={`${hint.word}-${index}`}
              label={hint.word}
              icon={hint.emoji}
              color={isSelected ? 'blue' : 'green'}
              dwell={false}
              onMouseEnter={() => handleHintHover(hint)}
              onMouseLeave={handleHintLeave}
              className={`text-xl ${isSelected ? 'underline' : ''}`}
              style={{
                gridColumn: `span ${gridColumnSpan}`,
              }}
            />
          );
        })}

        {/* "More" button - always in bottom right */}
        <Button
          label="More"
          icon="🔄"
          color="blue"
          dwell={false}
          onMouseEnter={handleMoreHover}
          onMouseLeave={handleHintLeave}
          className="text-xl"
        />
        </div>
      )}
      {/* Show loading skeletons while streaming */}
      {hints.length === 0 && isStreaming && (
        <div className="flex-1 grid grid-cols-5 gap-2 p-2">
          {Array.from({ length: 10 }, (_, index) => (
            <Button
              key={`skeleton-${index}`}
              loading={true}
              icon="placeholder"
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default Hints;
