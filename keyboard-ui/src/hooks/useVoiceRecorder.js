import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_VOICE_RECORDING_MS = 45000;

export function useVoiceRecorder({ conversationId, apiBaseUrl, onError }) {
  const [isRecording, setIsRecording] = useState(false);
  const [status, setStatus] = useState('idle'); // idle | starting | recording | stopping

  const mediaRecorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const voiceStreamIdRef = useRef(null);
  const voiceChunkSeqRef = useRef(0);
  const voiceStopTimeoutRef = useRef(null);
  const pendingFinalChunkRef = useRef(false);

  const notifyError = useCallback(
    (message) => {
      if (onError) onError(message);
    },
    [onError],
  );

  const cleanupVoiceTimeout = useCallback(() => {
    if (voiceStopTimeoutRef.current) {
      clearTimeout(voiceStopTimeoutRef.current);
      voiceStopTimeoutRef.current = null;
    }
  }, []);

  const stopMediaTracks = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  }, []);

  const sendVoiceChunk = useCallback(
    async (audioBlob, isFinal = false) => {
      if (!voiceStreamIdRef.current || !conversationId) return;

      const formData = new FormData();
      formData.append('stream_id', voiceStreamIdRef.current);
      formData.append('seq', String(voiceChunkSeqRef.current));
      formData.append('is_final', String(isFinal));
      formData.append('audio', audioBlob, `chunk-${voiceChunkSeqRef.current}.webm`);
      voiceChunkSeqRef.current += 1;

      try {
        const response = await fetch(`${apiBaseUrl}/api/conversations/${conversationId}/voice/chunk`, {
          method: 'POST',
          credentials: 'include',
          body: formData,
        });

        if (!response.ok) {
          throw new Error(`Failed to send audio chunk (${response.status})`);
        }

        if (isFinal) {
          voiceStreamIdRef.current = null;
        }
      } catch (err) {
        console.error('[Voice] Chunk upload failed', err);
        notifyError('Voice upload failed');
      }
    },
    [apiBaseUrl, conversationId, notifyError],
  );

  const stop = useCallback(
    (isAutoStop = false) => {
      if (!mediaRecorderRef.current) return;

      pendingFinalChunkRef.current = true;
      setStatus('stopping');
      cleanupVoiceTimeout();

      try {
        mediaRecorderRef.current.stop();
      } catch (err) {
        console.error('[Voice] Error stopping recorder', err);
      }

      if (isAutoStop) {
        notifyError('Recording stopped (time limit reached)');
      }
    },
    [cleanupVoiceTimeout, notifyError],
  );

  const start = useCallback(async () => {
    if (!conversationId) {
      notifyError('Open a conversation to record');
      return;
    }

    if (isRecording || status === 'starting') return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      notifyError('Microphone is not available in this browser');
      return;
    }

    try {
      setStatus('starting');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const startResponse = await fetch(`${apiBaseUrl}/api/conversations/${conversationId}/voice/start`, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });

      if (!startResponse.ok) {
        throw new Error(`Failed to start voice stream (${startResponse.status})`);
      }

      const startData = await startResponse.json();
      voiceStreamIdRef.current = startData.stream_id;
      voiceChunkSeqRef.current = 0;
      pendingFinalChunkRef.current = false;

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size > 0) {
          const isFinalChunk = pendingFinalChunkRef.current && recorder.state === 'inactive';
          sendVoiceChunk(event.data, isFinalChunk);
        }
      });

      recorder.addEventListener('error', (event) => {
        console.error('[Voice] Recorder error', event.error);
        notifyError('Microphone error');
        stop(true);
      });

      recorder.addEventListener('stop', () => {
        setIsRecording(false);
        setStatus('idle');
        cleanupVoiceTimeout();
        stopMediaTracks();
        pendingFinalChunkRef.current = false;
        mediaRecorderRef.current = null;
      });

      recorder.start(1500); // send chunks every 1.5s
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      setStatus('recording');

      voiceStopTimeoutRef.current = window.setTimeout(() => stop(true), MAX_VOICE_RECORDING_MS);
    } catch (err) {
      console.error('[Voice] Unable to start recording', err);
      notifyError('Unable to start microphone');
      setIsRecording(false);
      setStatus('idle');
      cleanupVoiceTimeout();
      stopMediaTracks();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // ignore
        }
      }
      mediaRecorderRef.current = null;
    }
  }, [apiBaseUrl, cleanupVoiceTimeout, conversationId, isRecording, notifyError, sendVoiceChunk, status, stopMediaTracks, stop]);

  useEffect(() => {
    return () => {
      cleanupVoiceTimeout();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop();
        } catch (err) {
          console.error('[Voice] Error cleaning up recorder', err);
        }
      }
      stopMediaTracks();
    };
  }, [cleanupVoiceTimeout, stopMediaTracks]);

  return {
    isRecording,
    status,
    start,
    stop,
  };
}

export default useVoiceRecorder;
