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
    const MAX_HINTS = context.settings.numHints || 19;

    const [hints, setHints] = useState([]);
    const [isStreaming, setIsStreaming] = useState(false);
    const containerHoverRef = useRef(false);
    const hoverTimerRef = useRef(null);
    const pendingRefreshRef = useRef(false);

    const buildTranscript = useCallback((messages = []) => {
      return messages
        .map((m) => {
          if (!m || !m.body) return null;
          const role = m.sender === 'contact' ? 'Partner' : 'You';
          return `${role}: ${m.body}`.trim();
        })
        .filter(Boolean)
        .join('\n');
    }, []);

    // Memoize selected hints set for performance
    const selectedHintsSet = useMemo(
      () => new Set(context.selectedHints.map((word) => word.toLowerCase())),
      [context.selectedHints]
    );

    useEffect(() => {
      console.log('[HintsPlugin] selectedHints updated', context.selectedHints);
    }, [context.selectedHints]);

    // Auto-unselect hints that are no longer in the list
    useEffect(() => {
      if (hints.length === 0 || context.selectedHints.length === 0) return;

      const currentHintWords = new Set(hints.map(h => h.word.toLowerCase()));
      const hintsToRemove = context.selectedHints.filter(
        hint => !currentHintWords.has(hint.toLowerCase())
      );

      if (hintsToRemove.length > 0 && context.setSelectedHints) {
        context.setSelectedHints((prev) =>
          prev.filter(h => !hintsToRemove.map(w => w.toLowerCase()).includes(h.toLowerCase()))
        );
      }
    }, [hints, context.selectedHints, context.setSelectedHints]);

    const buildPrompt = useCallback((excludeWords = []) => {
      const systemLines = [
        `Generate ${MAX_HINTS} single-word hints by calling push_hint exactly ${MAX_HINTS} times.`,
        'Each hint: ONE word (no spaces/hyphens) + ONE emoji.',
        'Cover diverse response directions: emotions, actions, topics.',
      ];

      if (excludeWords.length > 0) {
        systemLines.push(`IMPORTANT: Do NOT use any of these words: ${excludeWords.join(', ')}.`);
        systemLines.push('Generate completely different words that are not in this exclusion list.');
      }

      systemLines.push('Call push_hint immediately as you think of each hint.');

      const transcript = buildTranscript(context.recentMessages || []);
      const lastMessage = (context.recentMessages || []).slice(-1)[0];
      const lastMessageText = lastMessage?.body || '';

      const userPayload = {
        formality: 'casual',
        conversation_title: '', // ignored per requirement
        transcript,
        last_message: lastMessageText,
      };

      if (excludeWords.length > 0) {
        userPayload.excluded_words = excludeWords;
      }

      return `${systemLines.join('\n')}\n\nUser:\n${JSON.stringify(userPayload)}`;
    }, [MAX_HINTS, buildTranscript, context.recentMessages]);

    // Fetch hints with LLM
    const fetchHints = useCallback(async (excludeWords = [], forceRefresh = false) => {
      if (!context.conversationId || (containerHoverRef.current && !forceRefresh)) {
        return;
      }

      setHints([]);
      setIsStreaming(true);

      try {
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
                  const already = prev.find(
                    (h) => h.word.toLowerCase() === args.word.toLowerCase()
                  );
                  if (already) return prev;

                  const newHints = [...prev, { word: args.word, emoji: args.emoji }];
                  if (newHints.length > MAX_HINTS) {
                    return newHints.slice(-MAX_HINTS);
                  }
                  return newHints;
                });
              }
            },
            onComplete: () => {
              setIsStreaming(false);
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
      if (!context.conversationId) {
        return;
      }
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

    const toggleHintSelection = useCallback((hintWord) => {
      if (!context.setSelectedHints) return;
      context.setSelectedHints((prev) => {
        const normalized = hintWord.toLowerCase();
        const exists = prev.some((h) => h.toLowerCase() === normalized);
        const nextSelection = exists ? prev.filter((h) => h.toLowerCase() !== normalized) : [...prev, hintWord];
        console.log('[HintsPlugin] toggle', { hint: hintWord, action: exists ? 'deselect' : 'select', next: nextSelection });
        return nextSelection;
      });
      
      // Note: We don't manually call refreshOtherPlugins here because that would
      // trigger an immediate fetch with a stale context (before React re-renders).
      // Instead, SuggestionsPlugin will auto-refresh via its useEffect watching
      // context.selectedHints, which will fire after React updates with the new hints.
    }, [context]);

    // Handle hint selection
    const handleHintHover = (hint) => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
      }

      hoverTimerRef.current = setTimeout(() => {
        toggleHintSelection(hint.word);
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
        fetchHints(currentWords, true); // Force refresh even while hovering
      }, context.dwellTime);
    };

    // Container hover handlers for pending refresh
    const handleContainerMouseEnter = () => {
      containerHoverRef.current = true;
    };

    const handleContainerMouseLeave = () => {
      containerHoverRef.current = false;

      // If there's a pending refresh, do it now
      if (pendingRefreshRef.current) {
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
  },
};

export default HintsPlugin;

