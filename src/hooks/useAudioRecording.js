import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import AudioManager from "../helpers/audioManager";
import logger from "../utils/logger";
import { playStartCue, playStopCue } from "../utils/dictationCues";
import { getSettings } from "../stores/settingsStore";
import { getRecordingErrorTitle } from "../utils/recordingErrors";

export const useAudioRecording = (toast, options = {}) => {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const audioManagerRef = useRef(null);
  const startLockRef = useRef(false);
  const stopLockRef = useRef(false);
  const mediaEffectsFrameRef = useRef(null);
  const mediaEffectsTimeoutRef = useRef(null);
  const { onToggle } = options;

  const clearPendingStartMediaEffects = useCallback(() => {
    if (typeof window === "undefined") return;

    if (
      mediaEffectsFrameRef.current !== null &&
      typeof window.cancelAnimationFrame === "function"
    ) {
      window.cancelAnimationFrame(mediaEffectsFrameRef.current);
      mediaEffectsFrameRef.current = null;
    }

    if (mediaEffectsTimeoutRef.current !== null) {
      window.clearTimeout(mediaEffectsTimeoutRef.current);
      mediaEffectsTimeoutRef.current = null;
    }
  }, []);

  const runStartMediaEffects = useCallback(() => {
    mediaEffectsFrameRef.current = null;
    mediaEffectsTimeoutRef.current = null;

    const state = audioManagerRef.current?.getState?.();
    if (!state || (!state.isRecording && !state.isStreaming && !state.isStreamingStartInProgress)) {
      return;
    }

    const settings = getSettings();
    if (settings.pauseMediaOnDictation) {
      void window.electronAPI?.pauseMediaPlayback?.();
    }
    if (settings.muteSystemOutputOnDictation) {
      void window.electronAPI?.muteSystemOutput?.();
    }
  }, []);

  const scheduleStartMediaEffects = useCallback(() => {
    if (typeof window === "undefined") return;

    clearPendingStartMediaEffects();

    const queueEffects = () => {
      mediaEffectsFrameRef.current = null;
      mediaEffectsTimeoutRef.current = window.setTimeout(() => {
        runStartMediaEffects();
      }, 0);
    };

    if (typeof window.requestAnimationFrame === "function") {
      mediaEffectsFrameRef.current = window.requestAnimationFrame(queueEffects);
    } else {
      queueEffects();
    }
  }, [clearPendingStartMediaEffects, runStartMediaEffects]);

  const performStartRecording = useCallback(async () => {
    if (startLockRef.current) return false;
    startLockRef.current = true;
    try {
      if (!audioManagerRef.current) return false;

      const currentState = audioManagerRef.current.getState();
      if (currentState.isRecording || currentState.isProcessing) return false;

      // Retry STT config fetch if it wasn't loaded on mount (e.g. auth wasn't ready)
      if (!audioManagerRef.current.sttConfig) {
        const config = await window.electronAPI.getSttConfig?.();
        if (config?.success) {
          audioManagerRef.current.setSttConfig(config);
        }
      }

      const didStart = audioManagerRef.current.shouldUseStreaming()
        ? await audioManagerRef.current.startStreamingRecording()
        : await audioManagerRef.current.startRecording();

      if (didStart) {
        void playStartCue();
        scheduleStartMediaEffects();
      }

      return didStart;
    } finally {
      startLockRef.current = false;
    }
  }, [scheduleStartMediaEffects]);

  const performStopRecording = useCallback(async () => {
    if (stopLockRef.current) return false;
    stopLockRef.current = true;
    try {
      if (!audioManagerRef.current) return false;
      clearPendingStartMediaEffects();

      const currentState = audioManagerRef.current.getState();
      if (!currentState.isRecording && !currentState.isStreamingStartInProgress) return false;

      if (currentState.isStreaming || currentState.isStreamingStartInProgress) {
        void playStopCue();
        return await audioManagerRef.current.stopStreamingRecording();
      }

      const didStop = audioManagerRef.current.stopRecording();

      if (didStop) {
        void playStopCue();
      }

      return didStop;
    } finally {
      stopLockRef.current = false;
    }
  }, [clearPendingStartMediaEffects]);

  useEffect(() => {
    audioManagerRef.current = new AudioManager();

    audioManagerRef.current.setCallbacks({
      onStateChange: ({ isRecording, isProcessing, isStreaming }) => {
        setIsRecording(isRecording);
        setIsProcessing(isProcessing);
        setIsStreaming(isStreaming ?? false);
        if (!isStreaming) {
          setPartialTranscript("");
        }
        window.electronAPI?.sendRecordingOverlayUpdate?.({
          level: 0,
          isRecording,
          isProcessing,
        });
      },
      onAudioLevel: (level) => {
        window.electronAPI?.sendRecordingOverlayUpdate?.({
          level,
          isRecording: true,
          isProcessing: false,
        });
      },
      onError: (error) => {
        clearPendingStartMediaEffects();
        const title = getRecordingErrorTitle(error, t);
        toast({
          title,
          description: error.description,
          variant: "destructive",
          duration: error.code === "AUTH_EXPIRED" ? 8000 : undefined,
        });
        if (getSettings().muteSystemOutputOnDictation) {
          window.electronAPI?.restoreSystemOutput?.();
        }
        if (getSettings().pauseMediaOnDictation) {
          window.electronAPI?.resumeMediaPlayback?.();
        }
      },
      onPartialTranscript: (text) => {
        setPartialTranscript(text);
      },
      onTranscriptionComplete: async (result) => {
        clearPendingStartMediaEffects();
        if (getSettings().muteSystemOutputOnDictation) {
          window.electronAPI?.restoreSystemOutput?.();
        }
        if (getSettings().pauseMediaOnDictation) {
          window.electronAPI?.resumeMediaPlayback?.();
        }

        if (result.success) {
          const transcribedText = result.text?.trim();

          if (!transcribedText) {
            return;
          }

          setTranscript(result.text);

          const isStreaming = result.source?.includes("streaming");
          const { keepTranscriptionInClipboard } = getSettings();
          const pasteStart = performance.now();
          await audioManagerRef.current.safePaste(result.text, {
            ...(isStreaming ? { fromStreaming: true } : {}),
            restoreClipboard: !keepTranscriptionInClipboard,
          });
          logger.info(
            "Paste timing",
            {
              pasteMs: Math.round(performance.now() - pasteStart),
              source: result.source,
              textLength: result.text.length,
            },
            "streaming"
          );

          audioManagerRef.current.saveTranscription(result.text, result.rawText ?? result.text);

          if (result.source === "openai" && getSettings().useLocalWhisper) {
            toast({
              title: t("hooks.audioRecording.fallback.title"),
              description: t("hooks.audioRecording.fallback.description"),
              variant: "default",
            });
          }

          // Cloud usage: limit reached after this transcription
          if (result.source === "openwhispr" && result.limitReached) {
            // Notify control panel to show UpgradePrompt dialog
            window.electronAPI?.notifyLimitReached?.({
              wordsUsed: result.wordsUsed,
              limit:
                result.wordsRemaining !== undefined
                  ? result.wordsUsed + result.wordsRemaining
                  : 2000,
            });
          }

          if (audioManagerRef.current.shouldUseStreaming()) {
            audioManagerRef.current.warmupStreamingConnection();
          }
        }
      },
    });

    audioManagerRef.current.setContext("dictation");
    window.electronAPI.getSttConfig?.().then((config) => {
      if (config?.success && audioManagerRef.current) {
        audioManagerRef.current.setSttConfig(config);
        if (audioManagerRef.current.shouldUseStreaming()) {
          audioManagerRef.current.warmupStreamingConnection();
        }
      }
    });

    const handleToggle = async () => {
      if (!audioManagerRef.current) return;
      const currentState = audioManagerRef.current.getState();

      if (!currentState.isRecording && !currentState.isProcessing) {
        await performStartRecording();
      } else if (currentState.isRecording) {
        await performStopRecording();
      }
    };

    const handleStart = async () => {
      await performStartRecording();
    };

    const handleStop = async () => {
      await performStopRecording();
    };

    const disposeToggle = window.electronAPI.onToggleDictation(() => {
      handleToggle();
      onToggle?.();
    });

    const disposeStart = window.electronAPI.onStartDictation?.(() => {
      handleStart();
      onToggle?.();
    });

    const disposeStop = window.electronAPI.onStopDictation?.(() => {
      handleStop();
      onToggle?.();
    });

    const handleNoAudioDetected = () => {
      toast({
        title: t("hooks.audioRecording.noAudio.title"),
        description: t("hooks.audioRecording.noAudio.description"),
        variant: "default",
      });
    };

    const disposeNoAudio = window.electronAPI.onNoAudioDetected?.(handleNoAudioDetected);

    // Cleanup
    return () => {
      clearPendingStartMediaEffects();
      disposeToggle?.();
      disposeStart?.();
      disposeStop?.();
      disposeNoAudio?.();
      if (audioManagerRef.current) {
        audioManagerRef.current.cleanup();
      }
    };
  }, [
    clearPendingStartMediaEffects,
    toast,
    onToggle,
    performStartRecording,
    performStopRecording,
    t,
  ]);

  const cancelRecording = async () => {
    if (audioManagerRef.current) {
      clearPendingStartMediaEffects();
      const state = audioManagerRef.current.getState();
      if (getSettings().muteSystemOutputOnDictation) {
        window.electronAPI?.restoreSystemOutput?.();
      }
      if (getSettings().pauseMediaOnDictation) {
        window.electronAPI?.resumeMediaPlayback?.();
      }
      if (state.isStreaming) {
        return await audioManagerRef.current.stopStreamingRecording();
      }
      return audioManagerRef.current.cancelRecording();
    }
    return false;
  };

  const cancelProcessing = () => {
    if (audioManagerRef.current) {
      return audioManagerRef.current.cancelProcessing();
    }
    return false;
  };

  const toggleListening = async () => {
    if (!isRecording && !isProcessing) {
      await performStartRecording();
    } else if (isRecording) {
      await performStopRecording();
    }
  };

  return {
    isRecording,
    isProcessing,
    isStreaming,
    transcript,
    partialTranscript,
    startRecording: performStartRecording,
    stopRecording: performStopRecording,
    cancelRecording,
    cancelProcessing,
    toggleListening,
  };
};
