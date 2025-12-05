/**
 * useLLM Hook
 *
 * Provides a simple interface for plugins to make LLM requests.
 * The hook handles:
 * - Pusher subscription for streaming events
 * - Debouncing requests
 * - Error handling
 * - Loading states
 *
 * Plugins just provide prompts and tools - server decides provider/model.
 */

import { useEffect, useRef, useState } from 'react';
import Pusher from 'pusher-js';
import type { LLMRequest, LLMStreamCallbacks } from '../plugins/plugin-types';

interface UseLLMOptions extends LLMRequest {
  onToken?: (token: string) => void;
  onToolCall?: (toolName: string, args: Record<string, any>) => void;
  onComplete?: () => void;
  onError?: (error: string) => void;
  enabled?: boolean;           // Whether to execute the request
  debounce?: number;           // Debounce delay in ms (default: 300)
  deps?: any[];                // Dependencies that trigger re-fetch
}

interface UseLLMResult {
  loading: boolean;
  error: string | null;
}

/**
 * Generate a unique ID for tracking streaming sessions
 */
function generateStreamId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Hook for making LLM requests with streaming support
 */
export function useLLM(options: UseLLMOptions): UseLLMResult {
  const {
    prompt,
    tools,
    temperature = 0.7,
    maxTokens = 500,
    onToken,
    onToolCall,
    onComplete,
    onError,
    enabled = true,
    debounce = 300,
    deps = [],
  } = options;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pusherRef = useRef<Pusher | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!enabled) return;

    // Clear any existing timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    // Debounce the request
    debounceTimerRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);

      const streamId = generateStreamId();

      try {
        // Initialize Pusher if needed
        if (!pusherRef.current) {
          const pusherKey = process.env.REACT_APP_PUSHER_KEY;
          const pusherCluster = process.env.REACT_APP_PUSHER_CLUSTER || 'us2';

          if (!pusherKey) {
            throw new Error('Pusher configuration missing');
          }

          pusherRef.current = new Pusher(pusherKey, {
            cluster: pusherCluster,
          });
        }

        const pusher = pusherRef.current;
        const channel = pusher.subscribe(`llm-stream-${streamId}`);

        // Set up event handlers
        channel.bind('token', (data: any) => {
          if (onToken) onToken(data.token);
        });

        channel.bind('tool_call', (data: any) => {
          if (onToolCall) onToolCall(data.name, data.arguments);
        });

        channel.bind('complete', () => {
          setLoading(false);
          if (onComplete) onComplete();
          pusher.unsubscribe(`llm-stream-${streamId}`);
        });

        channel.bind('error', (data: any) => {
          setError(data.message);
          setLoading(false);
          if (onError) onError(data.message);
          pusher.unsubscribe(`llm-stream-${streamId}`);
        });

        // Start the streaming request
        const apiBaseUrl =
          process.env.REACT_APP_API_BASE_URL ||
          (window as any).API_BASE_URL ||
          (process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : '');

        const response = await fetch(`${apiBaseUrl}/api/llm/stream`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            tools,
            temperature,
            max_tokens: maxTokens,
            stream_id: streamId,
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();
        console.log(`[useLLM] Stream started: ${result.stream_id}`);
      } catch (e: any) {
        const errorMsg = e.message || 'Failed to start LLM stream';
        setError(errorMsg);
        setLoading(false);
        if (onError) onError(errorMsg);
      }
    }, debounce);

    // Cleanup function
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [prompt, enabled, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup Pusher on unmount
  useEffect(() => {
    return () => {
      if (pusherRef.current) {
        pusherRef.current.disconnect();
        pusherRef.current = null;
      }
    };
  }, []);

  return { loading, error };
}

/**
 * Standalone function for making one-off LLM requests
 * Useful when you need to make requests outside of React render cycle
 */
export async function llmRequest(
  request: LLMRequest,
  callbacks: LLMStreamCallbacks,
  conversationId?: string
): Promise<string> {
  const streamId = generateStreamId();

  const pusherKey = process.env.REACT_APP_PUSHER_KEY;
  const pusherCluster = process.env.REACT_APP_PUSHER_CLUSTER || 'us2';

  if (!pusherKey) {
    throw new Error('Pusher configuration missing');
  }

  const pusher = new Pusher(pusherKey, {
    cluster: pusherCluster,
  });

  const channel = pusher.subscribe(`llm-stream-${streamId}`);

  // Set up event handlers
  channel.bind('token', (data: any) => {
    if (callbacks.onToken) callbacks.onToken(data.token);
  });

  channel.bind('tool_call', (data: any) => {
    if (callbacks.onToolCall) callbacks.onToolCall(data.name, data.arguments);
  });

  channel.bind('complete', (data: any) => {
    if (callbacks.onComplete) callbacks.onComplete(data.usage);
    pusher.unsubscribe(`llm-stream-${streamId}`);
    pusher.disconnect();
  });

  channel.bind('error', (data: any) => {
    if (callbacks.onError) callbacks.onError(data.message);
    pusher.unsubscribe(`llm-stream-${streamId}`);
    pusher.disconnect();
  });

  // Start the streaming request
  const apiBaseUrl =
    process.env.REACT_APP_API_BASE_URL ||
    (window as any).API_BASE_URL ||
    (process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : '');

  const response = await fetch(`${apiBaseUrl}/api/llm/stream`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: request.prompt,
      tools: request.tools,
      temperature: request.temperature || 0.7,
      max_tokens: request.maxTokens || 500,
      stream_id: streamId,
      conversation_id: conversationId || null,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return streamId;
}
