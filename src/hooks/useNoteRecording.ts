import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import AudioManager from "../helpers/audioManager";
import logger from "../utils/logger";
import { getRecordingErrorTitle } from "../utils/recordingErrors";

interface UseNoteRecordingOptions {
  onTranscriptionComplete: (text: string) => void;
  onPartialTranscript?: (text: string) => void;
  onError?: (error: { title: string; description: string }) => void;
}

interface UseNoteRecordingReturn {
  isRecording: boolean;
  isProcessing: boolean;
  isStreaming: boolean;
  partialTranscript: string;
  streamingCommit: string | null;
  consumeStreamingCommit: () => void;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  cancelRecording: () => void;
}

export function useNoteRecording({
  onTranscriptionComplete,
  onPartialTranscript,
  onError,
}: UseNoteRecordingOptions): UseNoteRecordingReturn {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [streamingCommits, setStreamingCommits] = useState<string[]>([]);
  const audioManagerRef = useRef<InstanceType<typeof AudioManager> | null>(null);

  const callbacksRef = useRef({ onTranscriptionComplete, onPartialTranscript, onError });
  callbacksRef.current = { onTranscriptionComplete, onPartialTranscript, onError };

  useEffect(() => {
    const manager = new AudioManager();
    audioManagerRef.current = manager;
    manager.setSkipReasoning(true);

    manager.setCallbacks({
      onStateChange: ({
        isRecording,
        isProcessing,
        isStreaming,
      }: {
        isRecording: boolean;
        isProcessing: boolean;
        isStreaming?: boolean;
      }) => {
        setIsRecording(isRecording);
        setIsProcessing(isProcessing);
        setIsStreaming(isStreaming ?? false);
        if (!isStreaming) {
          setPartialTranscript("");
          setStreamingCommits([]);
        }
      },
      onError: (error: { title: string; description: string; code?: string }) => {
        const title = getRecordingErrorTitle(error, t);
        callbacksRef.current.onError?.({ title, description: error.description });
      },
      onPartialTranscript: (text: string) => {
        setPartialTranscript(text);
        callbacksRef.current.onPartialTranscript?.(text);
      },
      onStreamingCommit: (text: string) => {
        setStreamingCommits((pending) => [...pending, text]);
      },
      onTranscriptionComplete: (result: {
        success: boolean;
        text: string;
        source?: string;
        limitReached?: boolean;
        wordsUsed?: number;
        wordsRemaining?: number;
      }) => {
        if (result.success) {
          callbacksRef.current.onTranscriptionComplete(result.text);
          manager.warmupStreamingConnection();
        }
      },
    });

    manager.warmupStreamingConnection();

    return () => {
      manager.cleanup();
      audioManagerRef.current = null;
    };
  }, []);

  const startRecording = useCallback(async () => {
    const manager = audioManagerRef.current;
    if (!manager) return;

    const state = manager.getState();
    if (state.isRecording || state.isProcessing) return;

    const didStart = manager.shouldUseStreaming()
      ? await manager.startStreamingRecording()
      : await manager.startRecording();

    if (!didStart) {
      logger.debug("Note recording failed to start", {}, "notes");
    }
  }, []);

  const stopRecording = useCallback(async () => {
    const manager = audioManagerRef.current;
    if (!manager) return;

    const state = manager.getState();
    if (!state.isRecording) return;

    if (state.isStreaming) {
      await manager.stopStreamingRecording();
    } else {
      manager.stopRecording();
    }
  }, []);

  const cancelRecording = useCallback(() => {
    const manager = audioManagerRef.current;
    if (!manager) return;

    const state = manager.getState();
    if (state.isStreaming) {
      manager.stopStreamingRecording();
    } else {
      manager.cancelRecording();
    }
  }, []);

  const consumeStreamingCommit = useCallback(
    () => setStreamingCommits((pending) => pending.slice(1)),
    []
  );

  const streamingCommit = streamingCommits[0] ?? null;

  return {
    isRecording,
    isProcessing,
    isStreaming,
    partialTranscript,
    streamingCommit,
    consumeStreamingCommit,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
