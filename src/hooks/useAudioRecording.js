import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import AudioManager from "../helpers/audioManager";
import logger from "../utils/logger";
import { playStartCue, playStopCue } from "../utils/dictationCues";
import { getSettings } from "../stores/settingsStore";
import { expandSnippets } from "../utils/snippets";
import { getRecordingErrorTitle, getRecordingErrorDescription } from "../utils/recordingErrors";
import { isAccessibilitySkipped } from "../utils/permissions";
import {
  isAgentAllowed,
  isScreenContextAllowed,
  isTranscriptionContextAllowed,
} from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import { getOnboardingDemoKind } from "../utils/onboardingDemo";
import {
  buildLiveTranscriptionPreview,
  shouldShowByokStreamingPreview,
} from "../utils/transcriptionPreview";
import { canStartDictation } from "../utils/dictationReadiness";
import { waitForVisualFrames } from "../utils/visualFrame";

// Maps a failed selection-replacement code to its `selectionEditing.*` toast
// detail key; unlisted codes fall back to the generic "unavailable" message.
const SELECTION_EDIT_DETAIL_KEY_BY_CODE = {
  target_changed: "changed",
  selection_changed: "changed",
  session_expired: "expired",
  paste_failed: "pasteFailed",
};

export const useAudioRecording = (toast, options = {}) => {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isAssistantVoice, setIsAssistantVoice] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [micCaptureStatus, setMicCaptureStatus] = useState("inactive");
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const audioManagerRef = useRef(null);
  const startLockRef = useRef(false);
  const stopRequestedDuringStartRef = useRef(false);
  const stopLockRef = useRef(false);
  const preparationGenerationRef = useRef(0);
  const wasRecordingRef = useRef(false);
  const wasMicUnavailableRef = useRef(false);
  const demoKindRef = useRef("dictation");
  const onDemoEventRef = useRef(options.onDemoEvent);
  const reportedLifecycleRef = useRef(null);
  const lastStartOptionsRef = useRef({
    voiceAgentRequested: false,
    translationRequested: false,
  });
  const {
    onToggle,
    onAssistantCommand,
    dismissDictationError,
    onDictationError,
    getAssistantSelectionContext,
    onShowTranscript,
    onDemoEvent,
  } = options;

  useEffect(() => {
    onDemoEventRef.current = onDemoEvent;
  }, [onDemoEvent]);

  // Read through a ref so a re-render never tears down the AudioManager
  // (the mount effect below must not depend on this callback).
  const onAssistantCommandRef = useRef(onAssistantCommand);
  useEffect(() => {
    onAssistantCommandRef.current = onAssistantCommand;
  });
  const onShowTranscriptRef = useRef(onShowTranscript);
  useEffect(() => {
    onShowTranscriptRef.current = onShowTranscript;
  });
  const getAssistantSelectionContextRef = useRef(getAssistantSelectionContext);
  useEffect(() => {
    getAssistantSelectionContextRef.current = getAssistantSelectionContext;
  });

  const performStartRecording = useCallback(
    async ({ voiceAgentRequested = false, translationRequested = false } = {}) => {
      if (startLockRef.current) return false;
      lastStartOptionsRef.current = { voiceAgentRequested, translationRequested };
      startLockRef.current = true;
      stopRequestedDuringStartRef.current = false;
      let recordingStarted = false;
      try {
        if (!audioManagerRef.current) return false;
        const policyState = usePolicyStore.getState();
        if (
          !isTranscriptionContextAllowed(policyState, getSettings(), "dictation") ||
          (voiceAgentRequested && !isAgentAllowed(policyState))
        ) {
          toast({ title: t("common.managedByOrg"), variant: "default" });
          return false;
        }

        if (!canStartDictation(audioManagerRef.current.getState())) return false;

        const assistantSelectionContext = voiceAgentRequested
          ? (getAssistantSelectionContextRef.current?.() ?? null)
          : null;

        const preparationGeneration = ++preparationGenerationRef.current;
        setIsStopping(false);
        setIsPreparing(true);
        // Preserve the requested identity while Windows is still opening the
        // microphone; AudioManager confirms the same value once recording.
        setIsAssistantVoice(voiceAgentRequested);
        await waitForVisualFrames();
        if (preparationGeneration !== preparationGenerationRef.current) return false;

        // Start acquisition only after the compact thinking frame has reached
        // the compositor. startRecording() joins this prepared capture, so the
        // device still opens exactly once.
        void audioManagerRef.current.prepareMicCapture?.();

        // The floating dictation panel is non-focusable, so the foreground app is
        // still the user's actual editing target here. Refresh it for recordings
        // started from the panel itself as well as from global hotkeys; otherwise
        // paste can reactivate a stale target from the preceding dictation.
        try {
          await window.electronAPI.captureDictationTarget?.();
        } catch (error) {
          logger.warn("Failed to refresh dictation target", { error: error?.message });
        }

        demoKindRef.current = getOnboardingDemoKind(voiceAgentRequested);
        audioManagerRef.current.setVoiceAgentRequested(voiceAgentRequested);
        audioManagerRef.current.setAssistantSelectionContext(assistantSelectionContext);
        audioManagerRef.current.setTranslationRequested(translationRequested);
        if (voiceAgentRequested) {
          logger.info(
            "Voice agent recording start",
            { screenContextEnabled: !!getSettings().voiceAgentScreenContext },
            "reasoning"
          );
        }
        // getSettings() already reflects a managed policy that forces the
        // setting off; the predicate additionally fails closed while the
        // policy is still loading or errored.
        if (
          voiceAgentRequested &&
          getSettings().voiceAgentScreenContext &&
          isScreenContextAllowed(policyState)
        ) {
          audioManagerRef.current.beginScreenContextCapture();
        }

        // The selection to edit is whatever was highlighted at press time, so
        // read it now: it resolves while the user speaks instead of adding a
        // round trip after transcription.
        if (voiceAgentRequested && !assistantSelectionContext) {
          audioManagerRef.current.beginSelectionCapture();
        }

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
        recordingStarted = didStart;
        if (didStart) dismissDictationError?.();

        // A stop that landed while the start was still awaiting the mic open was
        // dropped (isRecording was still false), leaving a runaway recording
        // until the next hotkey press. Honor it now that we started.
        if (didStart && stopRequestedDuringStartRef.current) {
          window.electronAPI?.unregisterCancelHotkey?.();
          // Cue semantics mirror performStopRecording: unconditional for
          // streaming, gated on the stop landing for batch.
          if (audioManagerRef.current.getState().isStreaming) {
            void playStopCue();
            await audioManagerRef.current.stopStreamingRecording();
          } else if (audioManagerRef.current.stopRecording()) {
            void playStopCue();
          }
          return didStart;
        }

        // A quick tap can end the recording inside the start call itself (deferred
        // streaming stop) — don't pause media for a recording that already ended. See #1060.
        if (didStart && audioManagerRef.current.getState().isRecording) {
          if (getSettings().pauseMediaOnDictation) {
            window.electronAPI?.pauseMediaPlayback?.();
          }
          window.electronAPI?.registerCancelHotkey?.("Escape");
          void playStartCue();
        }

        return didStart;
      } finally {
        startLockRef.current = false;
        // A stop that landed mid-start set isStopping expecting the started
        // recording's state change to clear it; if the recording never began,
        // no state change will ever arrive.
        if (stopRequestedDuringStartRef.current && !recordingStarted) setIsStopping(false);
        stopRequestedDuringStartRef.current = false;
        if (!recordingStarted) {
          setIsPreparing(false);
          setIsAssistantVoice(false);
        }
      }
    },
    [t, toast, dismissDictationError]
  );

  const performStopRecording = useCallback(async () => {
    if (startLockRef.current) {
      stopRequestedDuringStartRef.current = true;
      setIsPreparing(false);
      setIsStopping(true);
      return true;
    }
    if (stopLockRef.current) return false;
    stopLockRef.current = true;
    try {
      if (!audioManagerRef.current) return false;

      const currentState = audioManagerRef.current.getState();
      if (!currentState.isRecording && !currentState.isStreamingStartInProgress) return false;

      window.electronAPI?.unregisterCancelHotkey?.();
      setIsPreparing(false);
      setIsStopping(true);
      // Contract to the stable thinking state before MediaRecorder/streaming
      // finalization can occupy the renderer on slower Windows machines.
      await waitForVisualFrames();

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
      setIsStopping(false);
    }
  }, []);

  useEffect(() => {
    audioManagerRef.current = new AudioManager();

    const reportLifecycle = (state) => {
      if (reportedLifecycleRef.current === state) return;
      reportedLifecycleRef.current = state;
      window.electronAPI?.dictationLifecycleStateChanged?.(state);
    };
    // Reset stale main-process state after a renderer reload or crash recovery.
    reportLifecycle("idle");

    const getRecoverableTranscript = (fallback = "") =>
      buildLiveTranscriptionPreview(
        audioManagerRef.current?.streamingFinalText,
        audioManagerRef.current?.streamingPartialText
      ).trim() || fallback.trim();

    const showDictationError = ({ title, description, transcript = "", duration }) => {
      const recoverAssistant = Boolean(audioManagerRef.current?.voiceAgentRequested);
      onDictationError?.({ recoverAssistant });
      const recoverableTranscript = getRecoverableTranscript(transcript);
      const actions = [
        {
          label: t("common.retry"),
          icon: "retry",
          dismissOnClick: false,
          onClick: () => performStartRecording(lastStartOptionsRef.current),
        },
      ];

      if (recoverableTranscript) {
        actions.push({
          label: t("hooks.audioRecording.errorActions.viewTranscript"),
          icon: "transcript",
          onClick: () => {
            onShowTranscriptRef.current?.(recoverableTranscript);
          },
        });
      }

      toast({
        title,
        description,
        variant: "destructive",
        presentation: "dictation-error",
        duration,
        actions,
      });
    };

    audioManagerRef.current.setCallbacks({
      onStateChange: ({ isRecording, isProcessing, isStreaming, micCaptureStatus }) => {
        reportLifecycle(isRecording ? "recording" : isProcessing ? "processing" : "idle");
        if (isRecording) {
          onDemoEventRef.current?.({ kind: demoKindRef.current, status: "listening" });
        } else if (isProcessing) {
          onDemoEventRef.current?.({ kind: demoKindRef.current, status: "processing" });
        }
        if (!isRecording) {
          window.electronAPI?.unregisterCancelHotkey?.();
          // Resume media the instant recording ends, not after transcription.
          if (wasRecordingRef.current && getSettings().pauseMediaOnDictation) {
            window.electronAPI?.resumeMediaPlayback?.();
          }
        }
        wasRecordingRef.current = isRecording;
        setIsRecording(isRecording);
        setIsProcessing(isProcessing);
        setIsStreaming(isStreaming ?? false);
        if (isRecording) setIsPreparing(false);
        if (!isRecording) setIsStopping(false);
        // The panel only mirrors assistant-routed recordings; a plain
        // dictation started while it is open must not masquerade as a
        // follow-up (its transcript takes the paste route, not the panel).
        setIsAssistantVoice(!!audioManagerRef.current?.voiceAgentRequested);
        if (micCaptureStatus) {
          setMicCaptureStatus(micCaptureStatus);
          const unavailable = micCaptureStatus === "unavailable";
          if (unavailable && !wasMicUnavailableRef.current) {
            wasMicUnavailableRef.current = true;
            toast({
              title: t("hooks.audioRecording.micDisconnected.title"),
              description: t("hooks.audioRecording.micDisconnected.description"),
              variant: "default",
            });
          } else if (micCaptureStatus === "active" && wasMicUnavailableRef.current) {
            wasMicUnavailableRef.current = false;
            toast({
              title: t("hooks.audioRecording.micRestored.title"),
              description: t("hooks.audioRecording.micRestored.description"),
              variant: "default",
            });
          } else if (micCaptureStatus === "inactive") {
            wasMicUnavailableRef.current = false;
          }
        }
        if (!isStreaming) {
          setPartialTranscript("");
        }
      },
      onError: (error) => {
        setIsPreparing(false);
        setIsStopping(false);
        if (error?.code === "TRANSCRIPTION_CANCELLED" || error?.code === "REASON_CANCELLED") return;
        onDemoEventRef.current?.({
          kind: demoKindRef.current,
          status: "error",
          message: error?.message,
        });
        if (error?.title !== "Paste Error") {
          window.electronAPI?.hideDictationPreview?.();
        }
        const title = getRecordingErrorTitle(error, t);
        const description = getRecordingErrorDescription(error, t);
        if (error?.variant === "default") {
          // Informational outcomes (SCREEN_CONTEXT_SKIPPED after a successful
          // text-only retry) are notices, not failures: no card, no Retry.
          toast({ title, description, variant: "default" });
        } else {
          showDictationError({
            title,
            description,
            duration: error?.code === "AUTH_EXPIRED" ? 8000 : undefined,
          });
        }
        if (getSettings().pauseMediaOnDictation) {
          window.electronAPI?.resumeMediaPlayback?.();
        }
      },
      onNoAudio: () => {
        setIsPreparing(false);
        setIsStopping(false);
        onDemoEventRef.current?.({
          kind: demoKindRef.current,
          status: "error",
          message: t("hooks.audioRecording.noAudio.title"),
        });
        window.electronAPI?.hideDictationPreview?.();
        if (getSettings().pauseMediaOnDictation) {
          window.electronAPI?.resumeMediaPlayback?.();
        }
        showDictationError({
          title: t("hooks.audioRecording.noAudio.title"),
          description: t("hooks.audioRecording.noAudio.description"),
        });
      },
      onPartialTranscript: (text) => {
        onDemoEventRef.current?.({ kind: demoKindRef.current, status: "partial", text });
        setPartialTranscript(text);
        const settings = getSettings();
        if (
          audioManagerRef.current?.getStreamingProviderName?.() !== "tinfoil-realtime" &&
          shouldShowByokStreamingPreview(
            settings.showTranscriptionPreview,
            settings.cloudTranscriptionMode,
            !!audioManagerRef.current?.voiceAgentRequested
          )
        ) {
          const previewText = buildLiveTranscriptionPreview(
            audioManagerRef.current?.streamingFinalText,
            text
          );
          window.electronAPI
            ?.updateDictationPreview?.(previewText)
            .catch((error) =>
              logger.warn("Failed to update transcription preview", { error: error?.message })
            );
        }
      },
      onTranscriptionComplete: async (result) => {
        if (result.success) {
          dismissDictationError?.();
          const transcribedText = result.text?.trim();

          if (!transcribedText) {
            window.electronAPI?.hideDictationPreview?.();
            showDictationError({
              title: t("hooks.audioRecording.noAudio.title"),
              description: t("hooks.audioRecording.noAudio.description"),
            });
            return;
          }

          // A selection edit must replace the model's exact result. Snippet
          // expansion is a dictation convenience and can otherwise mutate a
          // legitimate replacement that happens to contain a snippet trigger.
          if (!result.selectionEdit?.sessionId) {
            result.text = expandSnippets(result.text, getSettings().snippets);
          }

          setTranscript(result.text);
          onDemoEventRef.current?.({
            kind: demoKindRef.current,
            status: "success",
            text: result.text,
          });
          if (result.assistantConversation) {
            // The onboarding demo owns the transcript/result surface. Opening
            // the normal Assistant panel here would cover the flow even though
            // the main-process onboarding gate correctly hid normal surfaces.
            if (localStorage.getItem("onboardingCompleted") !== "true") {
              window.electronAPI?.hideDictationPreview?.();
            } else {
              // Panel-first: the command streams into the assistant panel;
              // nothing types at the cursor and nothing lands in the clipboard.
              // The directive's transcript is the command to send — it carries
              // the quoted selection when the selection-without-editor fallback
              // routed a highlighted passage here.
              window.electronAPI?.hideDictationPreview?.();
              const { screenContext, transcript, selectedContext } = result.assistantConversation;
              onAssistantCommandRef.current?.({
                text: expandSnippets(transcript, getSettings().snippets),
                attachment: screenContext
                  ? { image: screenContext.data, mediaType: screenContext.mediaType }
                  : null,
                selectedContext: selectedContext ?? null,
              });
            }
          } else {
            window.electronAPI?.completeDictationPreview?.({ text: result.text });
          }

          if (result.warning) {
            toast({
              title: t("hooks.audioRecording.partialTranscription.title"),
              description: t("hooks.audioRecording.partialTranscription.description"),
              variant: "default",
            });
          }

          const isStreaming = result.source?.includes("streaming");
          const { autoPasteEnabled, keepTranscriptionInClipboard } = getSettings();

          if (autoPasteEnabled && !result.assistantConversation) {
            const pasteStart = performance.now();
            let pasteSucceeded = true;
            if (result.selectionEdit?.sessionId) {
              const replacement = await window.electronAPI?.replaceSelectedText?.(
                result.selectionEdit.sessionId,
                result.text,
                {
                  restoreClipboard: !keepTranscriptionInClipboard,
                  allowClipboardFallback: isAccessibilitySkipped(),
                }
              );
              pasteSucceeded = replacement?.success === true;
              if (!pasteSucceeded) {
                window.electronAPI?.hideDictationPreview?.();
                if (keepTranscriptionInClipboard) {
                  await navigator.clipboard.writeText(result.text);
                }
                const detailKey =
                  SELECTION_EDIT_DETAIL_KEY_BY_CODE[replacement?.code] || "unavailable";
                showDictationError({
                  title: t("hooks.audioRecording.selectionEditing.notAppliedTitle"),
                  description: t(`hooks.audioRecording.selectionEditing.${detailKey}`),
                  transcript: result.rawText ?? result.text,
                });
              }
            } else {
              pasteSucceeded = await audioManagerRef.current.safePaste(result.text, {
                ...(isStreaming ? { fromStreaming: true } : {}),
                restoreClipboard: !keepTranscriptionInClipboard,
                allowClipboardFallback: isAccessibilitySkipped(),
              });
            }
            logger.info(
              "Paste timing",
              {
                pasteMs: Math.round(performance.now() - pasteStart),
                source: result.source,
                textLength: result.text.length,
                selectionEdit: !!result.selectionEdit,
                success: pasteSucceeded,
              },
              "streaming"
            );
          } else if (keepTranscriptionInClipboard && !result.assistantConversation) {
            await navigator.clipboard.writeText(result.text);
          }

          audioManagerRef.current.saveTranscription(result.text, result.rawText ?? result.text, {
            clientTranscriptionId: result.clientTranscriptionId,
          });

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
      onTranslationFallback: ({ reason }) => {
        // Fail-open: the raw text was still pasted; the toast removes the silence.
        toast({
          title:
            reason === "unreachable"
              ? t("hooks.audioRecording.translationFallback.unreachableTitle")
              : t("hooks.audioRecording.translationFallback.failedTitle"),
          description:
            reason === "unreachable"
              ? t("hooks.audioRecording.translationFallback.unreachableDescription")
              : t("hooks.audioRecording.translationFallback.failedDescription"),
          variant: "destructive",
        });
      },
    });

    // Keep overlay content protection in sync with the screen-context setting
    // so the dictation pill stays out of captures (survives window recreation).
    window.electronAPI.setScreenContextEnabled?.(getSettings().voiceAgentScreenContext);
    // A policy refresh can flip the effective screen-context value mid-session;
    // re-sync overlay content protection when it does.
    const unsubscribePolicy = usePolicyStore.subscribe(() => {
      window.electronAPI.setScreenContextEnabled?.(getSettings().voiceAgentScreenContext);
    });
    window.electronAPI.getSttConfig?.().then((config) => {
      if (config?.success && audioManagerRef.current) {
        audioManagerRef.current.setSttConfig(config);
        if (audioManagerRef.current.shouldUseStreaming()) {
          audioManagerRef.current.warmupStreamingConnection();
        }
      }
    });

    const handleToggle = async ({
      voiceAgentRequested = false,
      translationRequested = false,
    } = {}) => {
      if (!audioManagerRef.current) return;
      const currentState = audioManagerRef.current.getState();

      // A start still awaiting the mic open leaves isRecording false, so without
      // the lock check this toggle-off would take the start branch and be lost.
      if (startLockRef.current || currentState.isRecording) {
        await performStopRecording();
      } else if (canStartDictation(currentState)) {
        await performStartRecording({ voiceAgentRequested, translationRequested });
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

    const disposeVoiceAgentToggle = window.electronAPI.onToggleVoiceAgent?.(() => {
      handleToggle({ voiceAgentRequested: true });
      onToggle?.();
    });

    const disposeTranslationToggle = window.electronAPI.onToggleTranslation?.(() => {
      handleToggle({ translationRequested: true });
      onToggle?.();
    });

    const disposeStart = window.electronAPI.onStartDictation?.(() => {
      handleStart();
      onToggle?.();
    });

    const disposePrepare = window.electronAPI.onPrepareDictation?.(async () => {
      if (!audioManagerRef.current || startLockRef.current) return;
      if (!canStartDictation(audioManagerRef.current.getState())) return;
      const generation = ++preparationGenerationRef.current;
      setIsAssistantVoice(false);
      setIsPreparing(true);
      await waitForVisualFrames();
      if (generation !== preparationGenerationRef.current || startLockRef.current) return;
      void audioManagerRef.current.prepareMicCapture?.();
    });

    const disposeCancelPreparation = window.electronAPI.onCancelDictationPreparation?.(() => {
      preparationGenerationRef.current += 1;
      setIsPreparing(false);
      audioManagerRef.current?.cancelPreparedMicCapture?.();
    });

    const disposeStop = window.electronAPI.onStopDictation?.(() => {
      handleStop();
      onToggle?.();
    });

    // Cleanup
    return () => {
      reportLifecycle("idle");
      unsubscribePolicy();
      disposeToggle?.();
      disposeVoiceAgentToggle?.();
      disposeTranslationToggle?.();
      disposeStart?.();
      disposePrepare?.();
      disposeCancelPreparation?.();
      disposeStop?.();
      if (audioManagerRef.current) {
        audioManagerRef.current.cleanup();
      }
    };
  }, [
    toast,
    onToggle,
    performStartRecording,
    performStopRecording,
    dismissDictationError,
    onDictationError,
    t,
  ]);

  const cancelRecording = useCallback(async () => {
    if (audioManagerRef.current) {
      preparationGenerationRef.current += 1;
      setIsPreparing(false);
      setIsStopping(false);
      audioManagerRef.current.cancelPreparedMicCapture?.();
      window.electronAPI?.unregisterCancelHotkey?.();
      const state = audioManagerRef.current.getState();
      if (getSettings().pauseMediaOnDictation) {
        window.electronAPI?.resumeMediaPlayback?.();
      }
      // A streaming start in its mic-open phase is not yet `isStreaming`;
      // only the streaming cancel knows how to abandon it.
      if (state.isStreaming || state.isStreamingStartInProgress) {
        return await audioManagerRef.current.cancelStreamingRecording();
      }
      return audioManagerRef.current.cancelRecording();
    }
    return false;
  }, []);

  const cancelProcessing = () => {
    if (audioManagerRef.current) {
      return audioManagerRef.current.cancelProcessing();
    }
    return false;
  };

  const getAudioLevel = useCallback(
    () => audioManagerRef.current?.getRecordingAudioLevel() ?? null,
    []
  );

  const toggleListening = async ({
    voiceAgentRequested = false,
    translationRequested = false,
  } = {}) => {
    if (!isRecording && !isProcessing) {
      await performStartRecording({ voiceAgentRequested, translationRequested });
    } else if (isRecording) {
      await performStopRecording();
    }
  };

  return {
    isRecording,
    isProcessing,
    isStreaming,
    isAssistantVoice,
    isPreparing,
    isStopping,
    micCaptureStatus,
    transcript,
    partialTranscript,
    startRecording: performStartRecording,
    stopRecording: performStopRecording,
    cancelRecording,
    cancelProcessing,
    toggleListening,
    getAudioLevel,
  };
};
