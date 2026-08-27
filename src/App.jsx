import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import "./index.css";
import { useToast } from "./components/ui/useToast";
import { useHotkey } from "./hooks/useHotkey";
import { formatHotkeyListLabel } from "./utils/hotkeys";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { useAudioRecording } from "./hooks/useAudioRecording";
import { useAssistantPanel } from "./hooks/useAssistantPanel";
import { useLiveTranscriptPanel } from "./hooks/useLiveTranscriptPanel";
import { useMainWindowSizeOwner } from "./hooks/useMainWindowSizeOwner";
import { useMainProcessNotifications } from "./hooks/useMainProcessNotifications";
import { useListeningEntrancePhase } from "./hooks/useListeningEntrancePhase";
import { useWindowResizeCompensation } from "./hooks/useWindowResizeCompensation";
import { useSettingsStore } from "./stores/settingsStore";
import { isAgentAllowed } from "./stores/policyRules";
import { usePolicyStore } from "./stores/policyStore";
import { VoicePill } from "./components/dictation/VoicePill";
import { AssistantPanel } from "./components/dictation/AssistantPanel";
import { LiveTranscriptPanel } from "./components/dictation/LiveTranscriptPanel";
import { VoiceModePanelCore } from "./components/dictation/VoiceModePanelCore";
import { PillTooltip } from "./components/dictation/PillTooltip";
import { PillCommandMenu } from "./components/dictation/PillCommandMenu";
import { createMainWindowResizeCoordinator } from "./utils/mainWindowResizeCoordinator";
import {
  ASSISTANT_FOOTER_TRANSITION_TIMING,
  LIVE_TRANSCRIPT_ENTRANCE_TIMING,
  resolveLiveTranscriptEntrancePresentation,
  resolveAssistantFooterPresentation,
  resolveAgentModeActive,
  resolveListeningEntrancePresentation,
  resolveVoiceActivityPresentation,
  resolveVoiceHorizontalDirection,
  resolveVoicePanelCorePresentation,
  resolveVoicePillDock,
  resolveVoicePillInteraction,
  isVoicePillActivationKey,
  shouldActivateVoicePill,
  shouldOfferLiveTranscriptReopen,
  shouldSuppressPillForAssistantActions,
} from "./helpers/voicePillPresentation";

const formatPillHotkeyLabel = (value) =>
  formatHotkeyListLabel(value)
    .replace(/\s*\+\s*/g, " + ")
    .replace(/\s+/g, " ")
    .trim();

const UNMOUNTED_RESIZE = {
  success: false,
  superseded: true,
  message: "Resize coordinator not mounted",
};

export default function App() {
  const [isHovered, setIsHovered] = useState(false);
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const buttonRef = useRef(null);
  const { toast, dismiss, toastCount, dictationErrorActionCount, dismissByPresentation } =
    useToast();
  const { t } = useTranslation();
  const { hotkey } = useHotkey();
  const { isDragging, handleMouseDown, handleMouseUp } = useWindowDrag();

  const [dragStartPos, setDragStartPos] = useState(null);
  const [hasDragged, setHasDragged] = useState(false);

  // Floating icon auto-hide setting (read from store, synced via IPC)
  const floatingIconAutoHide = useSettingsStore((s) => s.floatingIconAutoHide);
  const panelStartPosition = useSettingsStore((s) => s.panelStartPosition);
  const prevAutoHideRef = useRef(floatingIconAutoHide);
  const [voiceHorizontalDirection, setVoiceHorizontalDirection] = useState(() =>
    resolveVoiceHorizontalDirection(panelStartPosition)
  );
  const [mainWindowHorizontalDirection, setMainWindowHorizontalDirection] = useState(null);

  const setWindowInteractivity = React.useCallback((shouldCapture) => {
    window.electronAPI?.setMainWindowInteractivity?.(shouldCapture);
  }, []);
  const dismissDictationError = React.useCallback(
    () => dismissByPresentation("dictation-error"),
    [dismissByPresentation]
  );

  useEffect(() => {
    setWindowInteractivity(false);
    return () => setWindowInteractivity(false);
  }, [setWindowInteractivity]);

  useEffect(() => {
    let disposed = false;
    const applyDirection = (direction) => {
      if (!disposed && (direction === "left" || direction === "right")) {
        setMainWindowHorizontalDirection(direction);
      }
    };
    const unsubscribe =
      window.electronAPI?.onMainWindowHorizontalDirectionChanged?.(applyDirection);
    const initialDirection = window.electronAPI?.getMainWindowHorizontalDirection?.();
    initialDirection?.then(applyDirection).catch(() => {});
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useWindowResizeCompensation();
  useMainProcessNotifications({ toast, dismiss, t });

  const agentAllowed = usePolicyStore(isAgentAllowed);

  const mainWindowResizeCoordinatorRef = useRef(null);
  useEffect(() => {
    // Created in the effect, not lazily during render: React StrictMode's
    // dev-only setup→cleanup→setup cycle then disposes and recreates it
    // instead of disposing the only instance for the rest of the session.
    const coordinator = createMainWindowResizeCoordinator({
      resizeMainWindow: (sizeKey) => window.electronAPI?.resizeMainWindow?.(sizeKey),
      resizeAssistantWindowToContent: (height) =>
        window.electronAPI?.resizeAssistantWindowToContent?.(height),
    });
    mainWindowResizeCoordinatorRef.current = coordinator;
    return () => {
      coordinator.dispose();
      if (mainWindowResizeCoordinatorRef.current === coordinator) {
        mainWindowResizeCoordinatorRef.current = null;
      }
    };
  }, []);

  const requestMainWindowSize = React.useCallback(
    (sizeKey) =>
      mainWindowResizeCoordinatorRef.current?.resizeMainWindow(sizeKey) ??
      Promise.resolve(UNMOUNTED_RESIZE),
    []
  );
  const resizeLiveTranscriptToContent = React.useCallback(
    (height) =>
      mainWindowResizeCoordinatorRef.current?.resizeAssistantWindowToContent(height) ??
      Promise.resolve(UNMOUNTED_RESIZE),
    []
  );

  const onPanelOpened = React.useCallback(() => setIsHovered(false), []);

  // The assistant panel and the recording pipeline reference each other
  // (voice commands flow in, closing the panel cancels a recording), and the
  // live transcript needs recording state as effect deps. These refs break the
  // render-order cycle; both are read only at event time, never during render.
  const recordingControlsRef = useRef({});
  const liveTranscriptApiRef = useRef(null);

  const assistant = useAssistantPanel({
    requestMainWindowSize,
    dictationErrorActionCount,
    recordingControlsRef,
    onPanelOpened,
  });
  const { noteDictationError, openRef: assistantOpenRef } = assistant;

  const handleDictationError = React.useCallback(
    (options = {}) => {
      noteDictationError(options);
      liveTranscriptApiRef.current?.dismissForError();
    },
    [noteDictationError]
  );

  const handleDictationToggle = React.useCallback(() => {
    setIsCommandMenuOpen(false);
    if (!assistantOpenRef.current && !liveTranscriptApiRef.current?.openRef.current) {
      setWindowInteractivity(false);
    }
  }, [assistantOpenRef, setWindowInteractivity]);

  const {
    isRecording,
    isProcessing,
    isAssistantVoice,
    isPreparing,
    isStopping,
    micCaptureStatus,
    toggleListening,
    cancelRecording,
    cancelProcessing,
    getAudioLevel,
  } = useAudioRecording(toast, {
    onToggle: handleDictationToggle,
    onDemoEvent: (event) => {
      // Demo sessions only exist while onboarding is incomplete — skip the IPC otherwise.
      if (localStorage.getItem("onboardingCompleted") === "true") return;
      window.electronAPI?.publishOnboardingDemoEvent?.(event);
    },
    onAssistantCommand: assistant.handleCommand,
    dismissDictationError,
    onDictationError: handleDictationError,
    getAssistantSelectionContext: assistant.getSelectionContext,
    onShowTranscript: (text) => {
      // While the Agent panel is open the main window's transcript is suppressed
      // (openPanel refuses under assistantOpenRef); the companion hosts it instead.
      if (assistantOpenRef.current) {
        window.electronAPI?.showAgentDictationFinalTranscript?.(text);
        return;
      }
      liveTranscriptApiRef.current?.showFinalText(text);
    },
    assistantOpenRef,
  });
  const isVisuallyProcessing = isProcessing || isPreparing || isStopping;

  useLayoutEffect(() => {
    recordingControlsRef.current = {
      isAssistantVoice,
      isRecording,
      isPreparing,
      isProcessing,
      cancelRecording,
      cancelProcessing,
    };
  });

  const liveTranscript = useLiveTranscriptPanel({
    resizeToContent: resizeLiveTranscriptToContent,
    assistantOpenRef,
    onWillOpen: onPanelOpened,
    isRecording,
    isProcessing,
    isAssistantVoice,
  });

  useLayoutEffect(() => {
    liveTranscriptApiRef.current = liveTranscript;
  });

  // Must run before the size owner's ladder effect below: the error teardown
  // drops the live transcript's open ref, which the ladder reads this commit.
  useEffect(() => {
    if (dictationErrorActionCount > 0) handleDictationError();
  }, [dictationErrorActionCount, handleDictationError]);

  // Direction is part of the interaction's geometry, not a live decoration.
  // Hold the origin through processing and panel exit so every close animation
  // returns to the same side from which that voice session started.
  const voiceDirectionLocked =
    isRecording || isVisuallyProcessing || assistant.mounted || liveTranscript.mounted;
  useLayoutEffect(() => {
    if (voiceDirectionLocked) return;
    setVoiceHorizontalDirection(
      mainWindowHorizontalDirection ?? resolveVoiceHorizontalDirection(panelStartPosition)
    );
  }, [mainWindowHorizontalDirection, panelStartPosition, voiceDirectionLocked]);

  const { beginThinking: beginAssistantThinking } = assistant;
  useEffect(() => {
    if (isAssistantVoice && isProcessing && assistantOpenRef.current) {
      beginAssistantThinking();
    }
  }, [isAssistantVoice, isProcessing, assistantOpenRef, beginAssistantThinking]);

  // While the Agent panel is open, plain dictation renders on the
  // opposite-edge companion pill — neither its recording nor its processing
  // may animate the footer pill here. Ownership returns at close INTENT
  // (assistant.closing), not at fade completion: beginClose hides the
  // companion immediately, so waiting for the fade would leave a running
  // recording with no visual owner for the fade duration.
  const voicePillOwnsActivity = !assistant.open || assistant.closing || isAssistantVoice;
  const voicePillIsRecording = isRecording && voicePillOwnsActivity;
  const voicePillIsProcessing = (isProcessing || isStopping) && voicePillOwnsActivity;
  const voiceActivity = resolveVoiceActivityPresentation({
    isRecording: voicePillIsRecording,
    // Mic warm-up is an acknowledged press, not work on a transcript. Keeping
    // isPreparing out of the thinking state leaves the press on the pulsing
    // "processing" mic-state pill instead of lighting the glow at hotkey time.
    isProcessing: voicePillIsProcessing,
    isAssistantVoice,
    assistantThinking: assistant.thinking || assistant.busy,
  });
  const listeningEntrancePhase = useListeningEntrancePhase(voicePillIsRecording);
  const listeningEntrance = resolveListeningEntrancePresentation({
    isRecording: voicePillIsRecording,
    phase: listeningEntrancePhase,
  });
  const isCompactPill = voicePillIsRecording
    ? listeningEntrance.compactPill
    : voiceActivity.compactPill;
  // The native window grows during the entrance's static thinking hold, not
  // when the pill starts its width transition: a setBounds landing mid
  // animation forces compositor work that visibly stutters the expansion, and
  // the growing pill can clip against the old bounds if the resize IPC lags.
  const windowFitsCompactPill = voicePillIsRecording || voiceActivity.compactPill;

  const { dictationErrorPillHandoffActive } = useMainWindowSizeOwner({
    requestMainWindowSize,
    dictationErrorActionCount,
    toastCount,
    isCommandMenuOpen,
    isCompactPill: windowFitsCompactPill,
    assistantOpen: assistant.open,
    assistantMounted: assistant.mounted,
    assistantOpenRef,
    liveTranscriptOpen: liveTranscript.open,
    liveTranscriptMounted: liveTranscript.mounted,
    liveTranscriptOpenRef: liveTranscript.openRef,
  });

  useEffect(() => {
    if (isCommandMenuOpen || toastCount > 0 || assistant.mounted || liveTranscript.mounted) {
      setWindowInteractivity(true);
    } else if (!isHovered) {
      setWindowInteractivity(false);
    }
  }, [
    isCommandMenuOpen,
    isHovered,
    toastCount,
    assistant.mounted,
    liveTranscript.mounted,
    setWindowInteractivity,
  ]);

  useEffect(() => {
    if (isRecording && dictationErrorActionCount > 0) {
      dismissByPresentation("dictation-error");
    }
  }, [isRecording, dictationErrorActionCount, dismissByPresentation]);

  // Sync auto-hide from main process — setState directly to avoid IPC echo
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onFloatingIconAutoHideChanged?.((enabled) => {
      localStorage.setItem("floatingIconAutoHide", String(enabled));
      useSettingsStore.setState({ floatingIconAutoHide: enabled });
    });
    return () => unsubscribe?.();
  }, []);

  const isRecordingRef = useRef(isRecording);

  useLayoutEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onCancelHotkeyPressed?.(() => {
      if (isRecordingRef.current) cancelRecording();
    });
    return () => unsubscribe?.();
  }, [cancelRecording]);

  // The Agent companion pill's cancel button routes here: only this renderer
  // owns the recording, so it decides what "cancel" means at arrival time.
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onCancelDictation?.(() => {
      if (isRecording || isPreparing) cancelRecording();
      else if (isProcessing) cancelProcessing();
    });
    return () => unsubscribe?.();
  }, [isRecording, isPreparing, isProcessing, cancelRecording, cancelProcessing]);

  // Auto-hide the floating icon when idle (setting enabled or dictation cycle completed)
  useEffect(() => {
    let hideTimeout;

    if (
      floatingIconAutoHide &&
      !isRecording &&
      !isVisuallyProcessing &&
      toastCount === 0 &&
      !dictationErrorPillHandoffActive &&
      !assistant.mounted &&
      !liveTranscript.mounted
    ) {
      // Delay briefly so processing can start after recording stops without a flash
      hideTimeout = setTimeout(() => {
        window.electronAPI?.hideWindow?.();
      }, 500);
    } else if (!floatingIconAutoHide && prevAutoHideRef.current) {
      window.electronAPI?.showDictationPanel?.();
    }

    prevAutoHideRef.current = floatingIconAutoHide;
    return () => clearTimeout(hideTimeout);
  }, [
    isRecording,
    isVisuallyProcessing,
    floatingIconAutoHide,
    toastCount,
    dictationErrorPillHandoffActive,
    assistant.mounted,
    liveTranscript.mounted,
  ]);

  const handleClose = () => {
    window.electronAPI.hideWindow();
  };

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === "Escape") {
        // The assistant panel owns Escape while it is open.
        if (assistant.mounted) return;
        if (isCommandMenuOpen) {
          setIsCommandMenuOpen(false);
        } else if (isRecording) {
          cancelRecording();
        } else if (isPreparing) {
          cancelRecording();
        } else if (isProcessing) {
          cancelProcessing();
        } else {
          handleClose();
        }
      }
    };

    document.addEventListener("keydown", handleKeyPress);
    return () => document.removeEventListener("keydown", handleKeyPress);
  }, [
    isCommandMenuOpen,
    assistant.mounted,
    isRecording,
    isPreparing,
    isProcessing,
    cancelRecording,
    cancelProcessing,
  ]);

  // Determine current mic state
  const getMicState = () => {
    if (isRecording && (micCaptureStatus === "reconnecting" || micCaptureStatus === "unavailable"))
      return "unavailable";
    if (isRecording) return "recording";
    if (isVisuallyProcessing) return "processing";
    if (isHovered && !isRecording && !isVisuallyProcessing) return "hover";
    return "idle";
  };

  const micState = getMicState();

  const getMicTooltip = () => {
    switch (micState) {
      case "recording":
        return t("app.mic.recording");
      case "unavailable":
        return t("app.mic.waitingForMicrophone");
      case "processing":
        return t("app.mic.processing");
      default:
        return formatPillHotkeyLabel(hotkey);
    }
  };

  const micTooltip = getMicTooltip();
  const assistantVoiceState =
    isRecording && isAssistantVoice
      ? "listening"
      : isProcessing && isAssistantVoice
        ? "transcribing"
        : "idle";
  const anyPanelOpen = assistant.open || liveTranscript.open;
  const anyPanelMounted = assistant.mounted || liveTranscript.mounted;
  const canReopenLiveTranscript =
    shouldOfferLiveTranscriptReopen({
      manuallyCollapsed: liveTranscript.manuallyCollapsed,
      isRecording,
      isProcessing,
      isAssistantVoice,
    }) && !anyPanelMounted;
  const agentModeActive = resolveAgentModeActive({
    isAssistantVoice,
    isRecording,
    isProcessing: isVisuallyProcessing,
    assistantPanelMounted: assistant.mounted,
  });
  const assistantFooter = resolveAssistantFooterPresentation(assistant.footerPhase);
  const voicePillInteraction = resolveVoicePillInteraction({
    assistantMounted: assistant.mounted,
    liveTranscriptMounted: liveTranscript.mounted,
    isRecording,
    isProcessing,
    isHovered,
  });
  const pillIsInteractive = voicePillInteraction.pillInteractive;
  const activateVoicePill = () => {
    if (!pillIsInteractive) return;
    if (canReopenLiveTranscript) {
      liveTranscript.reopen();
      return;
    }
    if (
      shouldActivateVoicePill({
        hasDragged,
        liveTranscriptMounted: liveTranscript.mounted,
        isProcessing: micState === "processing",
        isAgentThinking: voiceActivity.isAgentThinking,
      })
    ) {
      setIsCommandMenuOpen(false);
      toggleListening({ voiceAgentRequested: assistant.mounted });
    }
  };
  // Prefer a currently open mode over a sibling finishing its exit. The core
  // itself never unmounts; only these inner sections change ownership.
  const activeVoicePanel = resolveVoicePanelCorePresentation({
    assistantOpen: assistant.open,
    assistantMounted: assistant.mounted,
    liveTranscriptOpen: liveTranscript.open,
    liveTranscriptMounted: liveTranscript.mounted,
  });
  const activeVoicePanelMode = activeVoicePanel.mode;
  const liveTranscriptEntrance = resolveLiveTranscriptEntrancePresentation(
    liveTranscript.entrancePhase
  );
  const activeVoicePanelLabel =
    activeVoicePanelMode === "assistant"
      ? t("settingsPage.agentConfig.title")
      : activeVoicePanelMode === "live-transcript"
        ? t("transcriptionPreview.label")
        : undefined;
  const commonPillState =
    micState === "unavailable"
      ? "unavailable"
      : listeningEntrance.activeState ||
        voiceActivity.activeState ||
        (assistant.open ? (isHovered ? "hover" : "idle") : micState);
  const voicePillDock = resolveVoicePillDock({
    liveTranscriptOpen: liveTranscript.open,
    liveTranscriptEntrancePhase: liveTranscript.entrancePhase,
    assistantOpen: assistant.open,
    panelStartPosition,
    horizontalDirection: voiceHorizontalDirection,
  });
  const voicePillTravelDuration =
    liveTranscript.open && liveTranscript.entrancePhase === "encapsulate"
      ? LIVE_TRANSCRIPT_ENTRANCE_TIMING.encapsulateMs
      : LIVE_TRANSCRIPT_ENTRANCE_TIMING.horizontalMs;
  const dictationErrorSuppressesPill =
    dictationErrorActionCount > 0 || dictationErrorPillHandoffActive;
  // Keep one pill DOM node alive while final Agent actions own the footer. On
  // close it can fade and travel from the panel dock instead of mounting at
  // the resting dock halfway through the surface contraction.
  const assistantActionsSuppressPill = shouldSuppressPillForAssistantActions({
    assistantOpen: assistant.open,
    footerPillVisible: assistantFooter.pillVisible,
    assistantClosing: assistant.closing,
    hasLiveActivity: voicePillIsRecording || voicePillIsProcessing,
  });
  const pillVisuallySuppressed = dictationErrorSuppressesPill || assistantActionsSuppressPill;
  const pillInteractionSuppressed = pillVisuallySuppressed || assistant.closing;

  return (
    <div className="dictation-window">
      {/* The panel footer can hide this pill, but never unmounts it. */}
      <div
        className={`voice-pill-position voice-pill-position-${voicePillDock} fixed z-50 transition-opacity duration-150 ease-out ${
          pillInteractionSuppressed ? "pointer-events-none" : ""
        } ${pillVisuallySuppressed ? "opacity-0" : "opacity-100"}`}
        style={{
          "--voice-pill-travel-duration": `${voicePillTravelDuration}ms`,
        }}
        data-dictation-error-suppressed={dictationErrorSuppressesPill || undefined}
        data-assistant-actions-suppressed={assistantActionsSuppressPill || undefined}
        aria-hidden={pillVisuallySuppressed || undefined}
      >
        <div
          className="assistant-pill-presence relative flex items-center gap-2"
          data-assistant-footer-phase={assistant.open ? assistant.footerPhase : undefined}
          data-horizontal-direction={voiceHorizontalDirection}
          style={{
            "--assistant-pill-retreat-duration": `${ASSISTANT_FOOTER_TRANSITION_TIMING.pillRetreatMs}ms`,
            "--assistant-pill-entrance-duration": `${ASSISTANT_FOOTER_TRANSITION_TIMING.pillEntranceMs}ms`,
          }}
          onMouseEnter={() => {
            if (!pillIsInteractive) return;
            setIsHovered(true);
            setWindowInteractivity(true);
          }}
          onMouseLeave={() => {
            setIsHovered(false);
            if (!pillIsInteractive) return;
            if (!isCommandMenuOpen && !assistant.mounted) {
              setWindowInteractivity(false);
            }
          }}
        >
          <PillTooltip
            content={canReopenLiveTranscript ? t("transcriptionPreview.label") : micTooltip}
            disabled={anyPanelMounted}
            align={panelStartPosition === "center" ? "center" : voiceHorizontalDirection}
          >
            <VoicePill
              ref={buttonRef}
              variant={anyPanelOpen ? "panel" : "floating"}
              state={commonPillState}
              expanded={!anyPanelOpen && isCompactPill}
              collapseToLogo={
                listeningEntrance.collapseToLogo || assistantFooter.collapsePillToLogo
              }
              waveformVisible={listeningEntrance.waveformVisible}
              waveformOnlyWhileRecording={anyPanelMounted}
              integratedWithPanel={liveTranscript.open}
              agentMode={agentModeActive}
              showExpandChevron={canReopenLiveTranscript && isHovered}
              getAudioLevel={getAudioLevel}
              isDragging={isDragging}
              horizontalDirection={voiceHorizontalDirection}
              role={pillIsInteractive ? "button" : "status"}
              tabIndex={pillIsInteractive ? 0 : undefined}
              aria-label={
                canReopenLiveTranscript
                  ? t("transcriptionPreview.label")
                  : assistant.mounted
                    ? t("settingsPage.agentConfig.title")
                    : liveTranscript.mounted
                      ? t("transcriptionPreview.label")
                      : micTooltip
              }
              onMouseDown={(e) => {
                if (anyPanelMounted) {
                  setHasDragged(false);
                  return;
                }
                setIsCommandMenuOpen(false);
                setDragStartPos({ x: e.clientX, y: e.clientY });
                setHasDragged(false);
                handleMouseDown(e);
              }}
              onMouseMove={(e) => {
                if (anyPanelMounted) return;
                if (dragStartPos && !hasDragged) {
                  const distance = Math.sqrt(
                    Math.pow(e.clientX - dragStartPos.x, 2) +
                      Math.pow(e.clientY - dragStartPos.y, 2)
                  );
                  if (distance > 5) {
                    // 5px threshold for drag
                    setHasDragged(true);
                  }
                }
              }}
              onMouseUp={(e) => {
                if (anyPanelMounted) return;
                handleMouseUp(e);
                setDragStartPos(null);
              }}
              onClick={(e) => {
                activateVoicePill();
                e.preventDefault();
              }}
              onKeyDown={(event) => {
                if (event.repeat || !isVoicePillActivationKey(event.key)) return;
                event.preventDefault();
                activateVoicePill();
              }}
              onContextMenu={(e) => {
                if (anyPanelMounted) return;
                e.preventDefault();
                if (!hasDragged) {
                  setWindowInteractivity(true);
                  setIsCommandMenuOpen((prev) => !prev);
                }
              }}
            />
          </PillTooltip>
          {voicePillInteraction.cancelVisible && (
            <button
              type="button"
              aria-label={
                isRecording ? t("app.buttons.cancelRecording") : t("app.buttons.cancelProcessing")
              }
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (isRecording) cancelRecording();
                else cancelProcessing();
              }}
              className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border/55 bg-surface-2 text-muted-foreground shadow-sm transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <X size={13} strokeWidth={2.5} aria-hidden="true" />
            </button>
          )}
          {!anyPanelMounted && isCommandMenuOpen && (
            <PillCommandMenu
              buttonRef={buttonRef}
              isRecording={isRecording}
              agentAllowed={agentAllowed}
              isHovered={isHovered}
              setWindowInteractivity={setWindowInteractivity}
              onToggleListening={() => {
                toggleListening();
              }}
              onAskAssistant={() => {
                setIsCommandMenuOpen(false);
                assistant.openPanel();
              }}
              onHide={() => {
                setIsCommandMenuOpen(false);
                setWindowInteractivity(false);
                handleClose();
              }}
              onClose={() => setIsCommandMenuOpen(false)}
            />
          )}
        </div>
      </div>

      <VoiceModePanelCore
        mode={activeVoicePanelMode}
        open={activeVoicePanel.open}
        closing={activeVoicePanelMode === "assistant" && assistant.closing}
        stage={
          activeVoicePanelMode === "live-transcript" ? liveTranscriptEntrance.coreStage : "content"
        }
        horizontalDirection={voiceHorizontalDirection}
        label={activeVoicePanelLabel}
        measurementRevision={
          activeVoicePanelMode === "live-transcript" ? liveTranscript.measurementText : null
        }
        onPreferredHeightChange={liveTranscript.requestHeight}
        onClosingFadeComplete={assistant.completeContentFade}
      >
        {activeVoicePanelMode === "assistant" && assistant.mounted && (
          <AssistantPanel
            pendingCommand={assistant.pendingCommand}
            onCommandConsumed={assistant.handleCommandConsumed}
            onCommandDiscarded={assistant.handleCommandDiscarded}
            onCommandSettled={assistant.handleCommandSettled}
            initialConversationId={assistant.conversationId}
            onConversationIdChange={assistant.setConversationId}
            voiceState={assistantVoiceState}
            thinking={assistant.thinking && assistant.open}
            open={assistant.open}
            footerPhase={assistant.footerPhase}
            horizontalDirection={voiceHorizontalDirection}
            onClose={assistant.handleClose}
            onBusyChange={assistant.setBusy}
            onResponseReadyChange={assistant.setResponseReady}
            onResponseContent={assistant.handleResponseContent}
            onConversationReset={assistant.handleConversationReset}
            onSelectionContextChange={assistant.handleSelectionContextChange}
          />
        )}

        {activeVoicePanelMode !== "assistant" && (
          <LiveTranscriptPanel
            text={liveTranscript.mounted ? liveTranscript.text : ""}
            measurementText={liveTranscript.mounted ? liveTranscript.measurementText : ""}
            phase={liveTranscript.phase}
            processing={liveTranscript.mounted && isProcessing && !isAssistantVoice}
            controlsVisible={liveTranscript.mounted && liveTranscriptEntrance.controlsVisible}
            contentVisible={liveTranscript.mounted && liveTranscriptEntrance.contentVisible}
            onCollapse={() => liveTranscript.close({ suppress: true })}
            onHoldChange={liveTranscript.holdFinal}
          />
        )}
      </VoiceModePanelCore>
    </div>
  );
}
