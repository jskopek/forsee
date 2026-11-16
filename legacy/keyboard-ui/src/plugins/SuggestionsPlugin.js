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
      console.log('[SuggestionsPlugin] selectedHints context updated', context.selectedHints);
      selectedHintsRef.current = context.selectedHints;
    }, [context.selectedHints]);

    const buildTranscript = useCallback((messages = []) => {
      const lastMessages = messages.slice(-10); // limit context to last 10 lines
      return lastMessages
        .map((m) => {
          if (!m || !m.body) return null;
          const role = m.sender === 'contact' ? 'Partner' : 'You';
          return `${role}: ${m.body}`.trim();
        })
        .filter(Boolean)
        .join('\n');
    }, []);

    // Build LLM prompt mirroring server behavior
    const buildPrompt = useCallback(() => {
      const prefix = prefixRef.current.trim().slice(0, 40); // align with old prompt guard
      const hints = context.selectedHints || [];
      const hintText = hints.length > 0 ? hints.join(', ').slice(0, 160) : null;

      const systemLines = [
        `Generate ${context.settings.numSuggestions} short reply suggestions by calling push_suggestion exactly ${context.settings.numSuggestions} times.`,
        `Each suggestion: \u2264${context.settings.maxWords} words, natural speech, no emojis/quotes.`,
        'If user_hint exists, prioritize it over conversation content.',
        'If user_prefix exists, EVERY suggestion MUST start with a complete English word matching that prefix.',
        'Formality: casual. Call push_suggestion once per suggestion immediately as you think of it.',
      ];

      const transcript = buildTranscript(context.recentMessages || []);

      const userPayload = {
        formality: 'casual',
        conversation_title: '', // ignored per requirement
        transcript,
      };

      if (hintText) {
        userPayload.user_hint = hintText;
      }
      if (prefix) {
        userPayload.user_prefix = prefix;
      }

      const prompt = [
        { role: 'system', content: systemLines.join('\n') },
        { role: 'user', content: JSON.stringify(userPayload) },
      ];

      // Preserve string payload for backend while keeping structure explicit
      const promptString = JSON.stringify(prompt);
      console.log('[SuggestionsPlugin] buildPrompt', {
        prefix,
        hintCount: hints.length,
        hints,
        transcriptLines: (context.recentMessages || []).length,
      });
      return promptString;
    }, [context.settings, context.recentMessages, context.selectedHints, buildTranscript]);

    // Fetch suggestions with LLM
    const fetchSuggestions = useCallback(async () => {
      if (!context.conversationId || containerHoverRef.current) {
        return;
      }

      const currentPrefix = prefixRef.current.trim();
      const currentHints = context.selectedHints || [];
      console.log('[SuggestionsPlugin] fetchSuggestions', {
        prefix: currentPrefix,
        hints: currentHints,
      });
      setSuggestions([]);
      setIsStreaming(true);

      lastFetchedPrefixRef.current = currentPrefix;
      lastFetchedHintsRef.current = [...currentHints];

      try {
        const prompt = buildPrompt();
        await context.llmRequest(
          {
            prompt,
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
      if (!context.conversationId) {
        return;
      }
      fetchSuggestions();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Auto-fetch when prefix/hints change
    useEffect(() => {
      console.log('[SuggestionsPlugin] Auto-fetch effect triggered', {
        conversationId: context.conversationId,
        keyboardPrefix: context.keyboardPrefix,
        selectedHints: context.selectedHints,
      });
      
      if (!context.conversationId) {
        return;
      }

      const debounceTimer = setTimeout(() => {
        fetchSuggestions();
      }, 300);

      return () => {
        clearTimeout(debounceTimer);
      };
    }, [context.conversationId, context.keyboardPrefix, context.selectedHints, context.recentMessages, fetchSuggestions]);

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
  },
};

export default SuggestionsPlugin;
