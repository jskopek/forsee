/**
 * Hints Plugin
 *
 * Built-in plugin for generating single-word hints with emojis.
 * Uses the plugin architecture with no provider/model logic - server handles that.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Button from '../components/Button';

const HintsPlugin: Plugin = {
  metadata: {
    id: 'builtin.hints',
    name: 'Hints',
    description: 'Single-word hints with emojis to guide conversation direction',
    version: '1.0.0',
    author: 'Forsee',
    icon: '💡',
  },

  settings: {
    schema: [
      {
        key: 'numHints',
        label: 'Number of hints',
        type: 'range',
        description: 'How many hints to display (excluding More button)',
        default: 19,
        min: 10,
        max: 40,
        step: 1,
      },
      {
        key: 'temperature',
        label: 'Variety',
        type: 'range',
        description: 'Higher = more diverse hints',
        default: 0.7,
        min: 0,
        max: 1,
        step: 0.1,
      },
    ],
    defaults: {
      numHints: 19,
      temperature: 0.7,
    },
  },

  Component: ({ context }) => {
    console.log('[HintsPlugin] Component rendering, context:', {
      conversationId: context.conversationId,
      hasLLMRequest: !!context.llmRequest,
      settings: context.settings
    });

    const MAX_HINTS = context.settings.numHints || 19;

    const [hints, setHints] = useState([]);
    const [isStreaming, setIsStreaming] = useState(false);
    const containerHoverRef = useRef(false);
    const hoverTimerRef = useRef(null);
    const pendingRefreshRef = useRef(false);

    // Memoize selected hints set for performance
    const selectedHintsSet = useMemo(
      () => new Set(context.selectedHints.map((word) => word.toLowerCase())),
      [context.selectedHints]
    );

    // Auto-unselect hints that are no longer in the list
    useEffect(() => {
      if (hints.length === 0 || context.selectedHints.length === 0) return;

      const currentHintWords = new Set(hints.map(h => h.word.toLowerCase()));
      const hintsToRemove = context.selectedHints.filter(
        hint => !currentHintWords.has(hint.toLowerCase())
      );

      if (hintsToRemove.length > 0) {
        console.log('[HintsPlugin] Auto-unselecting hints no longer in list:', hintsToRemove);
        // Note: This would require adding an onHintUnselect callback to context
        // For now, we'll just log it
      }
    }, [hints, context.selectedHints]);

    // Build LLM prompt
    const buildPrompt = useCallback((excludeWords = []) => {
      let prompt = `Generate ${MAX_HINTS} single-word hints with emojis to guide conversation direction.\n\n`;

      if (excludeWords.length > 0) {
        prompt += `EXCLUDE these words: ${excludeWords.join(', ')}\n\n`;
      }

      prompt += `Requirements:\n`;
      prompt += `- Each hint is ONE word + ONE emoji\n`;
      prompt += `- Diverse directions (topics, emotions, actions)\n`;
      prompt += `- Appropriate emojis that match the word\n\n`;
      prompt += `Use the push_hint tool exactly ${MAX_HINTS} times.`;

      return prompt;
    }, [MAX_HINTS]);

    // Fetch hints with LLM
    const fetchHints = useCallback(async (excludeWords = [], forceRefresh = false) => {
      console.log('[HintsPlugin] fetchHints called', {
        conversationId: context.conversationId,
        containerHover: containerHoverRef.current,
        forceRefresh,
        excludeWords: excludeWords.length,
        hasLLMRequest: !!context.llmRequest
      });

      // Skip if hovering UNLESS it's a forced refresh (from "More" button)
      if (!context.conversationId || (containerHoverRef.current && !forceRefresh)) {
        console.log('[HintsPlugin] Skipping fetch - no conversationId or hovering (and not forced)');
        return;
      }

      console.log('[HintsPlugin] Starting fetch', excludeWords.length > 0 ? `(excluding ${excludeWords.length} hints)` : '', 'Building prompt...');
      setHints([]);
      setIsStreaming(true);

      try {
        console.log('[HintsPlugin] Calling context.llmRequest with prompt:', buildPrompt(excludeWords));
        await context.llmRequest(
          {
            prompt: buildPrompt(excludeWords),
            tools: [
              {
                name: 'push_hint',
                description: 'Add a hint to the list',
                parameters: {
                  type: 'object',
                  properties: {
                    word: {
                      type: 'string',
                      description: 'Single word hint',
                    },
                    emoji: {
                      type: 'string',
                      description: 'Related emoji',
                    },
                  },
                  required: ['word', 'emoji'],
                },
              },
            ],
            temperature: context.settings.temperature,
            maxTokens: 800,
          },
          {
            onToolCall: (toolName, args) => {
              if (toolName === 'push_hint' && args.word && args.emoji) {
                setHints((prev) => {
                  const newHints = [...prev, { word: args.word, emoji: args.emoji }];
                  // FIFO: Keep only last MAX_HINTS
                  if (newHints.length > MAX_HINTS) {
                    return newHints.slice(-MAX_HINTS);
                  }
                  return newHints;
                });
              }
            },
            onComplete: () => {
              setIsStreaming(false);
              console.log('[HintsPlugin] Streaming complete');
            },
            onError: (error) => {
              console.error('[HintsPlugin] Error:', error);
              setIsStreaming(false);
            },
          }
        );
      } catch (err) {
        console.error('[HintsPlugin] Error:', err);
        setIsStreaming(false);
      }
    }, [context, buildPrompt, MAX_HINTS]);

    // Auto-fetch on mount
    useEffect(() => {
      console.log('[HintsPlugin] Initial mount effect', {
        conversationId: context.conversationId
      });

      if (!context.conversationId) {
        console.log('[HintsPlugin] No conversationId, skipping initial fetch');
        return;
      }

      console.log('[HintsPlugin] Calling fetchHints on mount');
      fetchHints();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Calculate optimal grid layout (including "More" button)
    const gridConfig = useMemo(() => {
      const totalItems = hints.length + 1; // +1 for "More" button
      const cols = Math.ceil(Math.sqrt(totalItems));
      const rows = Math.ceil(totalItems / cols);
      const itemsInLastRow = totalItems % cols || cols;
      const lastRowIsIncomplete = itemsInLastRow < cols;
      return { cols, rows, itemsInLastRow, lastRowIsIncomplete };
    }, [hints]);

    // Handle hint selection
    const handleHintHover = (hint) => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
      }

      const normalized = hint.word.toLowerCase();
      const isSelected = selectedHintsSet.has(normalized);

      hoverTimerRef.current = setTimeout(() => {
        // Toggle hint selection
        // Note: We need to implement hint selection via context
        console.log('[HintsPlugin] Hint selected:', hint.word, 'isSelected:', isSelected);
        
        // For now, just speak the hint word to demonstrate functionality
        if (!isSelected) {
          context.speak(hint.word);
        }
      }, context.dwellTime);
    };

    const handleHintLeave = () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    };

    // Handle "More" button
    const handleMoreHover = () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
      }

      hoverTimerRef.current = setTimeout(() => {
        const currentWords = hints.map(h => h.word);
        console.log('[HintsPlugin] "More" button activated - fetching new hints excluding:', currentWords);
        fetchHints(currentWords, true); // Force refresh even while hovering
      }, context.dwellTime);
    };

    // Container hover handlers for pending refresh
    const handleContainerMouseEnter = () => {
      console.log('[HintsPlugin] Container hover started');
      containerHoverRef.current = true;
    };

    const handleContainerMouseLeave = () => {
      console.log('[HintsPlugin] Container hover ended');
      containerHoverRef.current = false;

      // If there's a pending refresh, do it now
      if (pendingRefreshRef.current) {
        console.log('[HintsPlugin] Executing pending refresh');
        pendingRefreshRef.current = false;
        fetchHints();
      }
    };

    // Cleanup
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
                gridColumnSpan = Math.floor(gridConfig.cols / gridConfig.itemsInLastRow);
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
  },

  onMessageAdded: (context) => {
    // Trigger re-fetch when message is added
    console.log('[HintsPlugin] Message added, triggering refresh');
  },
};

export default HintsPlugin;

