import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import "./index.css";
import { useToast } from "./components/ui/useToast";
import { useHotkey } from "./hooks/useHotkey";
import { formatHotkeyListLabel } from "./utils/hotkeys";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { useAudioRecording } from "./hooks/useAudioRecording";
import { useSettingsStore } from "./stores/settingsStore";
import { isAgentAllowed } from "./stores/policyRules";
import { usePolicyStore } from "./stores/policyStore";
import { VoicePill } from "./components/dictation/VoicePill";
import { AssistantPanel } from "./components/dictation/AssistantPanel";
import { LiveTranscriptPanel } from "./components/dictation/LiveTranscriptPanel";
import { VoiceModePanelCore } from "./components/dictation/VoiceModePanelCore";
import { createLatestValueScheduler } from "./utils/latestValueScheduler";

import { SIZE_RANK, resolveMainWindowSizeKey } from "./helpers/windowSizeLadder";
import {
  getLiveTranscriptEntranceTimeline,
  getListeningEntranceTimeline,
  LIVE_TRANSCRIPT_ENTRANCE_TIMING,
  resolveLiveTranscriptEntrancePresentation,
  resolveAssistantThinkingTransition,
  resolveListeningEntrancePresentation,
  resolveVoiceActivityPresentation,
  resolveVoiceHorizontalDirection,
  resolveVoicePanelCorePresentation,
  resolveVoicePillDock,
} from "./helpers/voicePillPresentation";

const ASSISTANT_TRANSITION_MS = 280;
const LIVE_TRANSCRIPT_RENDER_INTERVAL_MS = 50;

// Tooltip Component
const Tooltip = ({ children, content, emoji, align = "center", disabled = false }) => {
  const [isVisible, setIsVisible] = useState(false);

  const alignClass =
    align === "right" ? "right-0" : align === "left" ? "left-0" : "left-1/2 -translate-x-1/2";

  const arrowClass =
    align === "right" ? "right-3" : align === "left" ? "left-3" : "left-1/2 -translate-x-1/2";

  return (
    <div className="relative inline-block">
      <div onMouseEnter={() => setIsVisible(true)} onMouseLeave={() => setIsVisible(false)}>
        {children}
      </div>
      {isVisible && !disabled && (
        <div
          className={`absolute bottom-full ${alignClass} mb-2 px-1.5 py-1 text-[10px] text-popover-foreground bg-popover border border-border rounded-md z-10 shadow-lg transition-opacity duration-150 whitespace-nowrap`}
        >
          {emoji && <span className="mr-1">{emoji}</span>}
          {content}
          <div
            className={`absolute top-full ${arrowClass} w-0 h-0 border-l-2 border-r-2 border-t-2 border-transparent border-t-popover`}
          ></div>
        </div>
      )}
    </div>
  );
};

export default function App() {
  const [isHovered, setIsHovered] = useState(false);
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const commandMenuRef = useRef(null);
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

  useEffect(() => {
    const unsubscribeFallback = window.electronAPI?.onHotkeyFallbackUsed?.((data) => {
      toast({
        title: t("app.toasts.hotkeyChanged.title"),
        description: t("app.toasts.hotkeyChanged.description", {
          original: data.original,
          fallback: data.fallback,
        }),
        duration: 8000,
      });
    });

    const unsubscribeFailed = window.electronAPI?.onHotkeyRegistrationFailed?.((_data) => {
      toast({
        title: t("app.toasts.hotkeyUnavailable.title"),
        description: t("app.toasts.hotkeyUnavailable.description"),
        variant: "destructive",
      });
    });

    const showGpuFallbackToast = () => {
      toast({
        title: t("app.toasts.gpuFallback.title"),
        description: t("app.toasts.gpuFallback.description"),
        variant: "destructive",
      });
    };
    const unsubscribeCudaFallback =
      window.electronAPI?.onCudaFallbackNotification?.(showGpuFallbackToast);
    const unsubscribeGpuFallback =
      window.electronAPI?.onGpuFallbackNotification?.(showGpuFallbackToast);

    const unsubscribeCorrections = window.electronAPI?.onCorrectionsLearned?.((words) => {
      if (words && words.length > 0) {
        const wordList = words.map((w) => `\u201c${w}\u201d`).join(", ");
        let toastId;
        toastId = toast({
          title: t("app.toasts.addedToDict", { words: wordList }),
          variant: "success",
          duration: 6000,
          action: (
            <button
              onClick={async () => {
                try {
                  const result = await window.electronAPI?.undoLearnedCorrections?.(words);
                  if (result?.success) {
                    dismiss(toastId);
                  }
                } catch {
                  // silently fail — word stays in dictionary
                }
              }}
              className="text-[10px] font-medium px-2.5 py-1 rounded-sm whitespace-nowrap
                text-emerald-100/90 hover:text-white
                bg-emerald-500/15 hover:bg-emerald-500/25
                border border-emerald-400/20 hover:border-emerald-400/35
                transition-all duration-150"
            >
              {t("app.toasts.undo")}
            </button>
          ),
        });
      }
    });

    return () => {
      unsubscribeFallback?.();
      unsubscribeFailed?.();
      unsubscribeCudaFallback?.();
      unsubscribeGpuFallback?.();
      unsubscribeCorrections?.();
    };
  }, [toast, dismiss, t]);

  // Assistant panel: voice commands stream into the current conversation.
  const agentAllowed = usePolicyStore(isAgentAllowed);
  const [assistantPanelOpen, setAssistantPanelOpen] = useState(false);
  const [assistantPanelMounted, setAssistantPanelMounted] = useState(false);
  const [assistantResponseReady, setAssistantResponseReady] = useState(false);
  const [assistantThinking, setAssistantThinking] = useState(false);
  const [pendingCommand, setPendingCommand] = useState(null);
  const [panelConversationId, setPanelConversationId] = useState(null);
  const [liveTranscriptPanelOpen, setLiveTranscriptPanelOpen] = useState(false);
  const [liveTranscriptPanelMounted, setLiveTranscriptPanelMounted] = useState(false);
  const [liveTranscriptText, setLiveTranscriptText] = useState("");
  const [liveTranscriptPhase, setLiveTranscriptPhase] = useState("listening");
  const [liveTranscriptEntrancePhase, setLiveTranscriptEntrancePhase] = useState("idle");
  const assistantPanelOpenRef = useRef(assistantPanelOpen);
  const assistantCloseTimerRef = useRef(null);
  const assistantOpenFrameRef = useRef(null);
  const liveTranscriptPanelOpenRef = useRef(liveTranscriptPanelOpen);
  const liveTranscriptSuppressedRef = useRef(false);
  const liveTranscriptCloseTimerRef = useRef(null);
  const liveTranscriptOpenFrameRef = useRef(null);
  const liveTranscriptOpenPromiseRef = useRef(null);
  const liveTranscriptEntranceTimersRef = useRef([]);
  const liveTranscriptSourceTextRef = useRef("");
  const liveTranscriptTextSchedulerRef = useRef(null);
  const commandIdRef = useRef(0);

  if (liveTranscriptTextSchedulerRef.current === null) {
    liveTranscriptTextSchedulerRef.current = createLatestValueScheduler(
      setLiveTranscriptText,
      LIVE_TRANSCRIPT_RENDER_INTERVAL_MS
    );
  }

  const updateLiveTranscriptText = React.useCallback((text, { immediate = false } = {}) => {
    liveTranscriptSourceTextRef.current = text;
    liveTranscriptTextSchedulerRef.current.push(text, { immediate });
  }, []);

  const resetLiveTranscriptText = React.useCallback(() => {
    liveTranscriptTextSchedulerRef.current.cancel();
    liveTranscriptSourceTextRef.current = "";
    setLiveTranscriptText("");
  }, []);

  const clearLiveTranscriptEntranceTimers = React.useCallback(() => {
    for (const timer of liveTranscriptEntranceTimersRef.current) clearTimeout(timer);
    liveTranscriptEntranceTimersRef.current = [];
  }, []);

  useLayoutEffect(() => {
    assistantPanelOpenRef.current = assistantPanelOpen;
  }, [assistantPanelOpen]);

  useLayoutEffect(() => {
    liveTranscriptPanelOpenRef.current = liveTranscriptPanelOpen;
  }, [liveTranscriptPanelOpen]);

  const openAssistantPanel = React.useCallback(async () => {
    setAssistantThinking(false);
    if (assistantPanelOpenRef.current) return;
    assistantPanelOpenRef.current = true;
    setAssistantResponseReady(false);
    clearTimeout(assistantCloseTimerRef.current);
    // Grow the window before the panel mounts so its entrance never paints
    // clipped inside the compact pill bounds.
    await window.electronAPI?.resizeMainWindow?.("ASSISTANT");
    setAssistantPanelMounted(true);
    cancelAnimationFrame(assistantOpenFrameRef.current);
    assistantOpenFrameRef.current = requestAnimationFrame(() => {
      setAssistantPanelOpen(true);
    });
  }, []);

  useEffect(
    () => () => {
      clearTimeout(assistantCloseTimerRef.current);
      cancelAnimationFrame(assistantOpenFrameRef.current);
      clearTimeout(liveTranscriptCloseTimerRef.current);
      cancelAnimationFrame(liveTranscriptOpenFrameRef.current);
      clearLiveTranscriptEntranceTimers();
      liveTranscriptTextSchedulerRef.current.cancel();
    },
    [clearLiveTranscriptEntranceTimers]
  );

  const beginAssistantThinking = React.useCallback(() => {
    clearTimeout(assistantCloseTimerRef.current);
    cancelAnimationFrame(assistantOpenFrameRef.current);
    const transition = resolveAssistantThinkingTransition(assistantPanelOpenRef.current);
    assistantPanelOpenRef.current = transition.panelOpen;
    setAssistantPanelOpen(transition.panelOpen);
    setAssistantResponseReady(transition.responseReady);
    setAssistantThinking(transition.thinking);
    setAssistantPanelMounted(transition.panelMounted);
  }, []);

  const handleAssistantCommand = React.useCallback(
    (command) => {
      commandIdRef.current += 1;
      beginAssistantThinking();
      setPendingCommand({
        id: commandIdRef.current,
        text: command.text,
        attachment: command.attachment ?? null,
      });
    },
    [beginAssistantThinking]
  );

  const handleAssistantResponseContent = React.useCallback(() => {
    setAssistantThinking(false);
    void openAssistantPanel();
  }, [openAssistantPanel]);

  const handleCommandConsumed = React.useCallback((id) => {
    setPendingCommand((current) => (current?.id === id ? null : current));
  }, []);

  useEffect(() => {
    window.electronAPI?.setAssistantPanelOpen?.(assistantPanelOpen);
    if (assistantPanelOpen) setIsHovered(false);
  }, [assistantPanelOpen]);

  useEffect(() => {
    if (
      isCommandMenuOpen ||
      toastCount > 0 ||
      assistantPanelMounted ||
      liveTranscriptPanelMounted
    ) {
      setWindowInteractivity(true);
    } else if (!isHovered) {
      setWindowInteractivity(false);
    }
  }, [
    isCommandMenuOpen,
    isHovered,
    toastCount,
    assistantPanelMounted,
    liveTranscriptPanelMounted,
    setWindowInteractivity,
  ]);

  const handleDictationToggle = React.useCallback(() => {
    setIsCommandMenuOpen(false);
    if (!assistantPanelOpenRef.current && !liveTranscriptPanelOpenRef.current) {
      setWindowInteractivity(false);
    }
  }, [setWindowInteractivity]);

  const handlePanelPreferredHeight = React.useCallback((height) => {
    window.electronAPI?.resizeAssistantWindowToContent?.(height);
  }, []);

  // Agent Mode owns the fixed assistant footprint. Reassert it while open so
  // a preceding adaptive Live Transcript measurement (or a hot reload during
  // development) cannot leave the shared native window at a content height.
  useLayoutEffect(() => {
    if (!assistantPanelOpen) return;
    void window.electronAPI?.resizeMainWindow?.("ASSISTANT");
  }, [assistantPanelOpen]);

  const handleDictationError = React.useCallback(() => {
    // Errors replace the live transcript surface, so unmount it immediately
    // and suppress late preview events until the next recording begins.
    liveTranscriptSuppressedRef.current = true;
    cancelAnimationFrame(liveTranscriptOpenFrameRef.current);
    clearTimeout(liveTranscriptCloseTimerRef.current);
    clearLiveTranscriptEntranceTimers();
    liveTranscriptPanelOpenRef.current = false;
    setLiveTranscriptPanelOpen(false);
    setLiveTranscriptPanelMounted(false);
    resetLiveTranscriptText();
    setLiveTranscriptPhase("listening");
    setLiveTranscriptEntrancePhase("idle");
  }, [clearLiveTranscriptEntranceTimers, resetLiveTranscriptText]);

  useEffect(() => {
    if (dictationErrorActionCount > 0) handleDictationError();
  }, [dictationErrorActionCount, handleDictationError]);

  const {
    isRecording,
    isProcessing,
    isAssistantVoice,
    micCaptureStatus,
    toggleListening,
    cancelRecording,
    cancelProcessing,
    getAudioLevel,
  } = useAudioRecording(toast, {
    onToggle: handleDictationToggle,
    onAssistantCommand: handleAssistantCommand,
    dismissDictationError,
    onDictationError: handleDictationError,
  });

  // Direction is part of the interaction's geometry, not a live decoration.
  // Hold the origin through processing and panel exit so every close animation
  // returns to the same side from which that voice session started.
  const voiceDirectionLocked =
    isRecording || isProcessing || assistantPanelMounted || liveTranscriptPanelMounted;
  useLayoutEffect(() => {
    if (voiceDirectionLocked) return;
    setVoiceHorizontalDirection(
      mainWindowHorizontalDirection ?? resolveVoiceHorizontalDirection(panelStartPosition)
    );
  }, [mainWindowHorizontalDirection, panelStartPosition, voiceDirectionLocked]);

  useEffect(() => {
    if (isAssistantVoice && isProcessing && assistantPanelOpenRef.current) {
      beginAssistantThinking();
    }
  }, [isAssistantVoice, isProcessing, beginAssistantThinking]);

  const handleAssistantPanelClose = React.useCallback(() => {
    // Dismissing the panel mid-command must also abandon the command, or its
    // completion reopens the panel and answers a question the user withdrew.
    if (isAssistantVoice) {
      if (isRecording) cancelRecording();
      else if (isProcessing) cancelProcessing();
    }
    cancelAnimationFrame(assistantOpenFrameRef.current);
    assistantPanelOpenRef.current = false;
    setAssistantPanelOpen(false);
    setAssistantResponseReady(false);
    setAssistantThinking(false);
    setPendingCommand(null);
    clearTimeout(assistantCloseTimerRef.current);
    assistantCloseTimerRef.current = setTimeout(() => {
      setAssistantPanelMounted(false);
    }, ASSISTANT_TRANSITION_MS);
  }, [isAssistantVoice, isRecording, isProcessing, cancelRecording, cancelProcessing]);

  const closeLiveTranscriptPanel = React.useCallback(
    ({ suppress = false, clear = false } = {}) => {
      if (suppress) liveTranscriptSuppressedRef.current = true;
      if (clear) liveTranscriptTextSchedulerRef.current.flush();
      cancelAnimationFrame(liveTranscriptOpenFrameRef.current);
      clearLiveTranscriptEntranceTimers();
      liveTranscriptPanelOpenRef.current = false;
      setLiveTranscriptPanelOpen(false);
      setLiveTranscriptEntrancePhase("idle");
      clearTimeout(liveTranscriptCloseTimerRef.current);
      liveTranscriptCloseTimerRef.current = setTimeout(() => {
        setLiveTranscriptPanelMounted(false);
        if (clear) {
          resetLiveTranscriptText();
          setLiveTranscriptPhase("listening");
        }
      }, ASSISTANT_TRANSITION_MS);
    },
    [clearLiveTranscriptEntranceTimers, resetLiveTranscriptText]
  );

  const openLiveTranscriptPanel = React.useCallback(() => {
    if (
      liveTranscriptSuppressedRef.current ||
      assistantPanelOpenRef.current ||
      liveTranscriptPanelOpenRef.current
    ) {
      return;
    }
    if (liveTranscriptOpenPromiseRef.current) return;

    clearTimeout(liveTranscriptCloseTimerRef.current);
    clearLiveTranscriptEntranceTimers();
    liveTranscriptOpenPromiseRef.current = (async () => {
      await window.electronAPI?.resizeMainWindow?.("ASSISTANT");
      if (liveTranscriptSuppressedRef.current || assistantPanelOpenRef.current) return;
      // Reserve the mode before the next frame so repeated preview chunks
      // cannot restart the three-stage entrance while its first frame waits.
      liveTranscriptPanelOpenRef.current = true;
      setLiveTranscriptEntrancePhase("encapsulate");
      setLiveTranscriptPanelMounted(true);
      cancelAnimationFrame(liveTranscriptOpenFrameRef.current);
      liveTranscriptOpenFrameRef.current = requestAnimationFrame(() => {
        setLiveTranscriptPanelOpen(true);
        const timeline = getLiveTranscriptEntranceTimeline();
        liveTranscriptEntranceTimersRef.current = [
          setTimeout(() => setLiveTranscriptEntrancePhase("horizontal"), timeline.horizontalAtMs),
          setTimeout(() => setLiveTranscriptEntrancePhase("controls"), timeline.controlsAtMs),
          setTimeout(() => setLiveTranscriptEntrancePhase("content"), timeline.contentAtMs),
        ];
      });
    })().finally(() => {
      liveTranscriptOpenPromiseRef.current = null;
    });
  }, [clearLiveTranscriptEntranceTimers]);

  useEffect(() => {
    const reveal = () => {
      if (!liveTranscriptSuppressedRef.current) openLiveTranscriptPanel();
    };

    const disposeText = window.electronAPI?.onPreviewText?.((incoming) => {
      const text = incoming?.trim?.() || "";
      updateLiveTranscriptText(text);
      setLiveTranscriptPhase(text ? "live" : "listening");
      reveal();
    });
    const disposeAppend = window.electronAPI?.onPreviewAppend?.((chunk) => {
      const text = chunk?.trim?.();
      if (!text) return;
      const current = liveTranscriptSourceTextRef.current;
      updateLiveTranscriptText(current ? `${current} ${text}` : text);
      setLiveTranscriptPhase("live");
      reveal();
    });
    const disposeHold = window.electronAPI?.onPreviewHold?.((payload) => {
      liveTranscriptTextSchedulerRef.current.flush();
      setLiveTranscriptPhase(payload?.showCleanup ? "cleanup" : "final");
      reveal();
    });
    const disposeResult = window.electronAPI?.onPreviewResult?.((payload) => {
      const text = payload?.text?.trim?.();
      if (!text) {
        closeLiveTranscriptPanel({ clear: true });
        return;
      }
      updateLiveTranscriptText(text, { immediate: true });
      setLiveTranscriptPhase("final");
      reveal();
    });
    const disposeHide = window.electronAPI?.onPreviewHide?.(() => {
      closeLiveTranscriptPanel({ clear: true });
    });

    return () => {
      disposeText?.();
      disposeAppend?.();
      disposeHold?.();
      disposeResult?.();
      disposeHide?.();
    };
  }, [closeLiveTranscriptPanel, openLiveTranscriptPanel, updateLiveTranscriptText]);

  const previousNormalRecordingRef = useRef(false);
  useEffect(() => {
    const normalRecording = isRecording && !isAssistantVoice;
    if (normalRecording && !previousNormalRecordingRef.current) {
      liveTranscriptSuppressedRef.current = false;
      resetLiveTranscriptText();
      setLiveTranscriptPhase("listening");
    }
    previousNormalRecordingRef.current = normalRecording;

    if (isRecording && isAssistantVoice && liveTranscriptPanelMounted) {
      closeLiveTranscriptPanel({ clear: true });
    }
  }, [
    isAssistantVoice,
    isRecording,
    liveTranscriptPanelMounted,
    closeLiveTranscriptPanel,
    resetLiveTranscriptText,
  ]);

  // Single owner of the window size: panel > menu > toast > compact pill > base.
  // Grows apply immediately so content never clips; shrinks wait for the
  // content collapse animation to finish before the window snaps down.
  const voiceActivity = resolveVoiceActivityPresentation({
    isRecording,
    isProcessing,
    isAssistantVoice,
    assistantThinking,
  });
  const [listeningEntrancePhase, setListeningEntrancePhase] = useState("idle");
  useLayoutEffect(() => {
    if (!isRecording) {
      setListeningEntrancePhase("idle");
      return;
    }

    setListeningEntrancePhase("thinking");
    const timeline = getListeningEntranceTimeline();
    const expansionTimer = setTimeout(
      () => setListeningEntrancePhase("expanding"),
      timeline.expandAtMs
    );
    const settledTimer = setTimeout(
      () => setListeningEntrancePhase("settled"),
      timeline.settleAtMs
    );
    const waveformTimer = setTimeout(
      () => setListeningEntrancePhase("waveform"),
      timeline.waveformAtMs
    );

    return () => {
      clearTimeout(expansionTimer);
      clearTimeout(settledTimer);
      clearTimeout(waveformTimer);
    };
  }, [isRecording]);
  const listeningEntrance = resolveListeningEntrancePresentation({
    isRecording,
    phase: listeningEntrancePhase,
  });
  const isCompactPill = isRecording ? listeningEntrance.compactPill : voiceActivity.compactPill;
  const lastSizeKeyRef = useRef(null);
  useEffect(() => {
    const target = resolveMainWindowSizeKey({
      panelOpen: assistantPanelOpen || liveTranscriptPanelOpen,
      menuOpen: isCommandMenuOpen,
      toastCount,
      compactPill: isCompactPill,
      dictationErrorActionCount,
    });
    const prev = lastSizeKeyRef.current;
    lastSizeKeyRef.current = target;
    if (target === prev) return;
    if (target === "DICTATION_ERROR" || target === "DICTATION_ERROR_WITH_TRANSCRIPT") {
      // Establish the final width immediately. The hidden error card then
      // measures wrapping at that width and performs one content-height resize.
      window.electronAPI?.resizeMainWindow?.(target);
      return;
    }
    if (prev === "DICTATION_ERROR" || prev === "DICTATION_ERROR_WITH_TRANSCRIPT") {
      // The card has already completed its exit animation and been removed;
      // skip another delayed intermediate footprint.
      window.electronAPI?.resizeMainWindow?.(target);
      return;
    }
    if (!prev || SIZE_RANK[target] >= SIZE_RANK[prev]) {
      window.electronAPI?.resizeMainWindow?.(target);
      return;
    }
    const shrinkDelay = prev === "ASSISTANT" ? ASSISTANT_TRANSITION_MS : 340;
    const timeout = setTimeout(() => window.electronAPI?.resizeMainWindow?.(target), shrinkDelay);
    return () => clearTimeout(timeout);
  }, [
    assistantPanelOpen,
    liveTranscriptPanelOpen,
    isCommandMenuOpen,
    toastCount,
    isCompactPill,
    dictationErrorActionCount,
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

  // Auto-hide the floating icon when idle (setting enabled or dictation cycle completed)
  useEffect(() => {
    let hideTimeout;

    if (
      floatingIconAutoHide &&
      !isRecording &&
      !isProcessing &&
      toastCount === 0 &&
      !assistantPanelMounted &&
      !liveTranscriptPanelMounted
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
    isProcessing,
    floatingIconAutoHide,
    toastCount,
    assistantPanelMounted,
    liveTranscriptPanelMounted,
  ]);

  const handleClose = () => {
    window.electronAPI.hideWindow();
  };

  useEffect(() => {
    if (!isCommandMenuOpen) {
      return;
    }

    const handleClickOutside = (event) => {
      if (
        commandMenuRef.current &&
        !commandMenuRef.current.contains(event.target) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target)
      ) {
        setIsCommandMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isCommandMenuOpen]);

  useEffect(() => {
    const handleKeyPress = (e) => {
      if (e.key === "Escape") {
        // The assistant panel owns Escape while it is open.
        if (assistantPanelMounted) return;
        if (isCommandMenuOpen) {
          setIsCommandMenuOpen(false);
        } else if (isRecording) {
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
    assistantPanelMounted,
    isRecording,
    isProcessing,
    cancelRecording,
    cancelProcessing,
  ]);

  // Determine current mic state
  const getMicState = () => {
    if (isRecording && (micCaptureStatus === "reconnecting" || micCaptureStatus === "unavailable"))
      return "unavailable";
    if (isRecording) return "recording";
    if (isProcessing) return "processing";
    if (isHovered && !isRecording && !isProcessing) return "hover";
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
        return formatHotkeyListLabel(hotkey);
    }
  };

  const micTooltip = getMicTooltip();
  const assistantVoiceState =
    isRecording && isAssistantVoice
      ? "listening"
      : isProcessing && isAssistantVoice
        ? "transcribing"
        : "idle";
  const anyPanelOpen = assistantPanelOpen || liveTranscriptPanelOpen;
  const anyPanelMounted = assistantPanelMounted || liveTranscriptPanelMounted;
  // Prefer a currently open mode over a sibling finishing its exit. The core
  // itself never unmounts; only these inner sections change ownership.
  const activeVoicePanel = resolveVoicePanelCorePresentation({
    assistantOpen: assistantPanelOpen,
    assistantMounted: assistantPanelMounted,
    liveTranscriptOpen: liveTranscriptPanelOpen,
    liveTranscriptMounted: liveTranscriptPanelMounted,
  });
  const activeVoicePanelMode = activeVoicePanel.mode;
  const liveTranscriptEntrance = resolveLiveTranscriptEntrancePresentation(
    liveTranscriptEntrancePhase
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
        (assistantPanelOpen ? "idle" : micState);
  const voicePillDock = resolveVoicePillDock({
    liveTranscriptOpen: liveTranscriptPanelOpen,
    liveTranscriptEntrancePhase,
    assistantOpen: assistantPanelOpen,
    panelStartPosition,
    horizontalDirection: voiceHorizontalDirection,
  });
  const voicePillTravelDuration =
    liveTranscriptPanelOpen && liveTranscriptEntrancePhase === "encapsulate"
      ? LIVE_TRANSCRIPT_ENTRANCE_TIMING.encapsulateMs
      : LIVE_TRANSCRIPT_ENTRANCE_TIMING.horizontalMs;

  return (
    <div className="dictation-window">
      {/* The panel footer owns this pill until final-response actions replace it. */}
      {dictationErrorActionCount === 0 && (!assistantPanelOpen || !assistantResponseReady) && (
        <div
          className={`voice-pill-position voice-pill-position-${voicePillDock} fixed z-50`}
          style={{
            "--voice-pill-travel-duration": `${voicePillTravelDuration}ms`,
          }}
        >
          <div
            className="relative flex items-center gap-2"
            onMouseEnter={() => {
              if (anyPanelMounted) return;
              setIsHovered(true);
              setWindowInteractivity(true);
            }}
            onMouseLeave={() => {
              if (anyPanelMounted) return;
              setIsHovered(false);
              if (!isCommandMenuOpen) {
                setWindowInteractivity(false);
              }
            }}
          >
            <Tooltip
              content={micTooltip}
              disabled={anyPanelMounted}
              align={panelStartPosition === "center" ? "center" : voiceHorizontalDirection}
            >
              <VoicePill
                ref={buttonRef}
                variant={anyPanelOpen ? "panel" : "floating"}
                state={commonPillState}
                expanded={!anyPanelOpen && isCompactPill}
                collapseToLogo={listeningEntrance.collapseToLogo}
                beamActive={listeningEntrance.beamActive ?? undefined}
                waveformVisible={listeningEntrance.waveformVisible}
                waveformOnlyWhileRecording={liveTranscriptPanelMounted}
                getAudioLevel={getAudioLevel}
                isDragging={isDragging}
                horizontalDirection={voiceHorizontalDirection}
                role={anyPanelMounted ? "status" : "button"}
                aria-label={
                  assistantPanelMounted
                    ? t("settingsPage.agentConfig.title")
                    : liveTranscriptPanelMounted
                      ? t("transcriptionPreview.label")
                      : micTooltip
                }
                onMouseDown={(e) => {
                  if (anyPanelMounted) return;
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
                  if (anyPanelMounted) return;
                  if (!hasDragged && micState !== "processing") {
                    setIsCommandMenuOpen(false);
                    toggleListening();
                  }
                  e.preventDefault();
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
            </Tooltip>
            {!anyPanelMounted && isCommandMenuOpen && (
              <div
                ref={commandMenuRef}
                className="absolute bottom-full right-0 mb-3 w-48 rounded-lg border border-border bg-popover text-popover-foreground shadow-lg backdrop-blur-sm"
                onMouseEnter={() => {
                  setWindowInteractivity(true);
                }}
                onMouseLeave={() => {
                  if (!isHovered) {
                    setWindowInteractivity(false);
                  }
                }}
              >
                <button
                  className="w-full px-3 py-2 text-left text-sm font-medium hover:bg-muted focus:bg-muted focus:outline-none"
                  onClick={() => {
                    toggleListening();
                  }}
                >
                  {isRecording
                    ? t("app.commandMenu.stopListening")
                    : t("app.commandMenu.startListening")}
                </button>
                {agentAllowed && (
                  <>
                    <div className="h-px bg-border" />
                    <button
                      className="w-full px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                      onClick={() => {
                        setIsCommandMenuOpen(false);
                        openAssistantPanel();
                      }}
                    >
                      {t("app.commandMenu.askAssistant")}
                    </button>
                  </>
                )}
                <div className="h-px bg-border" />
                <button
                  className="w-full px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                  onClick={() => {
                    setIsCommandMenuOpen(false);
                    setWindowInteractivity(false);
                    handleClose();
                  }}
                >
                  {t("app.commandMenu.hideForNow")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <VoiceModePanelCore
        mode={activeVoicePanelMode}
        open={activeVoicePanel.open}
        stage={
          activeVoicePanelMode === "live-transcript" ? liveTranscriptEntrance.coreStage : "content"
        }
        horizontalDirection={voiceHorizontalDirection}
        label={activeVoicePanelLabel}
        onPreferredHeightChange={handlePanelPreferredHeight}
      >
        {activeVoicePanelMode === "assistant" && assistantPanelMounted && (
          <AssistantPanel
            pendingCommand={pendingCommand}
            onCommandConsumed={handleCommandConsumed}
            initialConversationId={panelConversationId}
            onConversationIdChange={setPanelConversationId}
            voiceState={assistantVoiceState}
            thinking={assistantThinking && assistantPanelOpen}
            open={assistantPanelOpen}
            onClose={handleAssistantPanelClose}
            onResponseReadyChange={setAssistantResponseReady}
            onResponseContent={handleAssistantResponseContent}
          />
        )}

        {activeVoicePanelMode === "live-transcript" && liveTranscriptPanelMounted && (
          <LiveTranscriptPanel
            text={liveTranscriptText}
            phase={liveTranscriptPhase}
            processing={isProcessing && !isAssistantVoice}
            controlsVisible={liveTranscriptEntrance.controlsVisible}
            contentVisible={liveTranscriptEntrance.contentVisible}
            onCollapse={() => closeLiveTranscriptPanel({ suppress: true })}
          />
        )}
      </VoiceModePanelCore>
    </div>
  );
}
