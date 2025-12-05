/**
 * Suggestions Plugin
 *
 * Built-in plugin for generating AI-powered reply suggestions.
 * Uses the plugin architecture with no provider/model logic - server handles that.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { Plugin } from './plugin-types';
import Panel from '../components/Panel';
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
    const MAX_SUGGESTIONS = context.settings.numSuggestions || 6;

    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [isStreaming, setIsStreaming] = useState(false);
    const containerHoverRef = useRef(false);
    const hoverTimerRef = useRef<NodeJS.Timeout | null>(null);
    const prefixRef = useRef(context.keyboardPrefix);
    const selectedHintsRef = useRef(context.selectedHints);
    const lastFetchedPrefixRef = useRef('');
    const lastFetchedHintsRef = useRef<string[]>([]);

    // Update refs when context changes
    useEffect(() => {
      prefixRef.current = context.keyboardPrefix;
    }, [context.keyboardPrefix]);

    useEffect(() => {
      selectedHintsRef.current = context.selectedHints;
    }, [context.selectedHints]);

    // Build LLM prompt
    const buildPrompt = useCallback((): string => {
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
      if (!context.conversationId || containerHoverRef.current) {
        console.log('[SuggestionsPlugin] Skipping fetch');
        return;
      }

      console.log('[SuggestionsPlugin] Starting fetch');
      setSuggestions([]);
      setIsStreaming(true);

      const currentPrefix = prefixRef.current.trim();
      const currentHints = selectedHintsRef.current;
      lastFetchedPrefixRef.current = currentPrefix;
      lastFetchedHintsRef.current = [...currentHints];

      try {
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
            onToolCall: (toolName: string, args: Record<string, any>) => {
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
            onError: (error: string) => {
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

    // Auto-fetch on mount and when prefix/hints change
    useEffect(() => {
      if (!context.conversationId) return;

      const debounceTimer = setTimeout(() => {
        fetchSuggestions();
      }, 300);

      return () => clearTimeout(debounceTimer);
    }, [context.conversationId, context.keyboardPrefix, context.selectedHints, fetchSuggestions]);

    // Handle suggestion selection
    const applySuggestion = (suggestion: string) => {
      if (hoverTimerRef.current) {
        clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      context.speak(suggestion);
    };

    const handleSuggestionHover = (suggestion: string) => {
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
