/**
 * Suggestions Plugin
 *
 * Built-in plugin for generating AI-powered reply suggestions.
 * Uses the plugin architecture with no provider/model logic - server handles that.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Button from '../components/Button';

const SuggestionsPlugin: Plugin = {
  metadata: {
    id: 'builtin.suggestions',
    name: 'Suggestions',
    description: 'AI-generated reply suggestions based on conversation context',
    version: '1.0.0',
    author: 'Forsee',
    icon: '💬',
  },

  settings: {
    schema: [
      {
        key: 'numSuggestions',
        label: 'Number of suggestions',
        type: 'range',
        description: 'How many suggestions to generate',
        default: 6,
        min: 2,
        max: 10,
        step: 1,
      },
      {
        key: 'temperature',
        label: 'Creativity',
        type: 'range',
        description: 'Higher = more creative, lower = more predictable',
        default: 0.3,
        min: 0,
        max: 1,
        step: 0.1,
      },
      {
        key: 'maxWords',
        label: 'Max words per suggestion',
        type: 'number',
        description: 'Maximum length of each suggestion',
        default: 12,
        min: 5,
        max: 30,
      },
    ],
    defaults: {
      numSuggestions: 6,
      temperature: 0.3,
      maxWords: 12,
    },
  },

  Component: ({ context }) => {
    console.log('[SuggestionsPlugin] Component rendering, context:', {
      conversationId: context.conversationId,
      keyboardPrefix: context.keyboardPrefix,
      selectedHints: context.selectedHints,
      hasLLMRequest: !!context.llmRequest,
      settings: context.settings
    });

    const MAX_SUGGESTIONS = context.settings.numSuggestions || 6;

    const [suggestions, setSuggestions] = useState([]);
    const [isStreaming, setIsStreaming] = useState(false);
    const containerHoverRef = useRef(false);
    const hoverTimerRef = useRef(null);
    const prefixRef = useRef(context.keyboardPrefix);
    const selectedHintsRef = useRef(context.selectedHints);
    const lastFetchedPrefixRef = useRef('');
    const lastFetchedHintsRef = useRef([]);

    // Update refs when context changes
    useEffect(() => {
      prefixRef.current = context.keyboardPrefix;
    }, [context.keyboardPrefix]);

    useEffect(() => {
      selectedHintsRef.current = context.selectedHints;
    }, [context.selectedHints]);

    // Build LLM prompt
    const buildPrompt = useCallback(() => {
      const prefix = prefixRef.current.trim();
      const hints = selectedHintsRef.current;
      const hintText = hints.length > 0 ? hints.join(', ') : null;

      let prompt = `Generate ${context.settings.numSuggestions} natural reply suggestions.\n\n`;

      if (prefix) {
        prompt += `All suggestions MUST start with: "${prefix}"\n`;
      }

      if (hintText) {
        prompt += `Consider these hint words for guidance: ${hintText}\n`;
      }

      prompt += `\nRequirements:\n`;
      prompt += `- Each suggestion must be ${context.settings.maxWords} words or fewer\n`;
      prompt += `- Natural, conversational tone\n`;
      prompt += `- No emojis, no quotes\n`;
      prompt += `- Diverse options (different directions/tones)\n\n`;
      prompt += `Use the push_suggestion tool exactly ${context.settings.numSuggestions} times.`;

      return prompt;
    }, [context.settings]);

    // Fetch suggestions with LLM
    const fetchSuggestions = useCallback(async () => {
      console.log('[SuggestionsPlugin] fetchSuggestions called', {
        conversationId: context.conversationId,
        containerHover: containerHoverRef.current,
        hasLLMRequest: !!context.llmRequest
      });

      if (!context.conversationId || containerHoverRef.current) {
        console.log('[SuggestionsPlugin] Skipping fetch - no conversationId or hovering');
        return;
      }

      console.log('[SuggestionsPlugin] Starting fetch, building prompt...');
      setSuggestions([]);
      setIsStreaming(true);

      const currentPrefix = prefixRef.current.trim();
      const currentHints = selectedHintsRef.current;
      lastFetchedPrefixRef.current = currentPrefix;
      lastFetchedHintsRef.current = [...currentHints];

      try {
        console.log('[SuggestionsPlugin] Calling context.llmRequest with prompt:', buildPrompt());
        await context.llmRequest(
          {
            prompt: buildPrompt(),
            tools: [
              {
                name: 'push_suggestion',
                description: 'Add a suggestion to the list',
                parameters: {
                  type: 'object',
                  properties: {
                    suggestion: {
                      type: 'string',
                      description: 'The suggestion text',
                    },
                  },
                  required: ['suggestion'],
                },
              },
            ],
            temperature: context.settings.temperature,
            maxTokens: 500,
          },
          {
            onToolCall: (toolName, args) => {
              if (toolName === 'push_suggestion' && args.suggestion) {
                setSuggestions((prev) => {
                  const newSuggestions = [...prev, args.suggestion];
                  // FIFO: Keep only last N suggestions
                  if (newSuggestions.length > MAX_SUGGESTIONS) {
                    return newSuggestions.slice(-MAX_SUGGESTIONS);
                  }
                  return newSuggestions;
                });
              }
            },
            onComplete: () => {
              setIsStreaming(false);
              console.log('[SuggestionsPlugin] Streaming complete');
            },
            onError: (error) => {
              console.error('[SuggestionsPlugin] Error:', error);
              setIsStreaming(false);
            },
          }
        );
      } catch (err) {
        console.error('[SuggestionsPlugin] Error:', err);
        setIsStreaming(false);
      }
    }, [context, buildPrompt, MAX_SUGGESTIONS]);

    // Initial fetch on mount
    useEffect(() => {
      console.log('[SuggestionsPlugin] Initial mount effect', {
        conversationId: context.conversationId
      });

      if (!context.conversationId) {
        console.log('[SuggestionsPlugin] No conversationId on mount, skipping');
        return;
      }

      console.log('[SuggestionsPlugin] Making initial fetch on mount');
      fetchSuggestions();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Auto-fetch when prefix/hints change
    useEffect(() => {
      console.log('[SuggestionsPlugin] Prefix/hints change effect triggered', {
        conversationId: context.conversationId,
        keyboardPrefix: context.keyboardPrefix,
        selectedHints: context.selectedHints
      });

      if (!context.conversationId) {
        console.log('[SuggestionsPlugin] No conversationId, skipping');
        return;
      }

      // Skip if this is the initial state (empty prefix and no hints)
      if (context.keyboardPrefix === '' && context.selectedHints.length === 0) {
        console.log('[SuggestionsPlugin] Initial state, skipping (will use mount effect)');
        return;
      }

      console.log('[SuggestionsPlugin] Setting debounce timer for fetch...');
      const debounceTimer = setTimeout(() => {
        console.log('[SuggestionsPlugin] Debounce timer fired, calling fetchSuggestions');
        fetchSuggestions();
      }, 300);

      return () => {
        console.log('[SuggestionsPlugin] Clearing debounce timer');
        clearTimeout(debounceTimer);
      };
    }, [context.conversationId, context.keyboardPrefix, context.selectedHints, fetchSuggestions]);

    // Handle suggestion selection
    const applySuggestion = (suggestion) => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      context.speak(suggestion);
    };

    const handleSuggestionHover = (suggestion) => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);

      hoverTimerRef.current = setTimeout(() => {
        applySuggestion(suggestion);
      }, context.dwellTime);
    };

    const handleSuggestionLeave = () => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
    };

    const handleContainerMouseEnter = () => {
      containerHoverRef.current = true;
    };

    const handleContainerMouseLeave = () => {
      containerHoverRef.current = false;

      // Check if we need to refresh
      const currentPrefix = prefixRef.current.trim();
      const currentHints = selectedHintsRef.current;
      if (
        currentPrefix !== lastFetchedPrefixRef.current ||
        JSON.stringify(currentHints) !== JSON.stringify(lastFetchedHintsRef.current)
      ) {
        console.log('[SuggestionsPlugin] Refetching after hover');
        fetchSuggestions();
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
        {suggestions.length === 0 && !isStreaming && (
          <div className="flex-1 flex items-center justify-center bg-bg-main">
            <div className="text-white text-lg">No suggestions available</div>
          </div>
        )}

        {(suggestions.length > 0 || isStreaming) && (
          <div
            className="flex-1 grid grid-cols-1"
            style={{ gridTemplateRows: `repeat(${MAX_SUGGESTIONS}, 1fr)` }}
          >
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
                <Button key={`skeleton-${index}`} loading={true} />
              ) : null;
            })}
          </div>
        )}
      </div>
    );
  },

  onMessageAdded: (context) => {
    // Trigger re-fetch when message is added
    // The component will handle this via useEffect
    console.log('[SuggestionsPlugin] Message added, component will refresh');
  },
};

export default SuggestionsPlugin;
