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
import {
  calculateWindowAnchorCompensation,
  createMainWindowResizeCoordinator,
} from "./utils/mainWindowResizeCoordinator";
import { createDictationErrorPillHandoff } from "./utils/dictationErrorPillHandoff";

import { SIZE_RANK, resolveMainWindowSizeKey } from "./utils/windowSizeLadder";
import {
  ASSISTANT_FOOTER_TRANSITION_TIMING,
  getAssistantFooterTransitionTimeline,
  getLiveTranscriptEntranceTimeline,
  getListeningEntranceTimeline,
  LIVE_TRANSCRIPT_ENTRANCE_TIMING,
  LIVE_TRANSCRIPT_SURFACE_LIMITS,
  resolveLiveTranscriptEntrancePresentation,
  resolveAssistantThinkingTransition,
  resolveAssistantFooterPresentation,
  resolveAgentModeActive,
  resolveListeningEntrancePresentation,
  resolveVoiceActivityPresentation,
  resolveVoiceHorizontalDirection,
  resolveVoicePanelCorePresentation,
  resolveVoicePillDock,
  shouldOfferLiveTranscriptReopen,
} from "./helpers/voicePillPresentation";

const ASSISTANT_TRANSITION_MS = 320;
const ASSISTANT_CONTENT_FADE_FALLBACK_MS = 260;
const LIVE_TRANSCRIPT_RENDER_INTERVAL_MS = 50;
const LIVE_TRANSCRIPT_SHELL_GROW_MS = 180;
const formatPillHotkeyLabel = (value) =>
  formatHotkeyListLabel(value)
    .replace(/\s*\+\s*/g, " + ")
    .replace(/\s+/g, " ")
    .trim();

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
          className={`absolute bottom-full ${alignClass} mb-2 px-1.5 py-1 text-[10px] text-popover-foreground bg-popover border border-border rounded-full z-10 shadow-lg transition-opacity duration-150 whitespace-nowrap`}
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
  const [dictationErrorPillHandoffActive, setDictationErrorPillHandoffActive] = useState(false);
  const dictationErrorActionCountRef = useRef(dictationErrorActionCount);
  const assistantErrorDownplayRequestedRef = useRef(false);
  const dictationErrorPillHandoffRef = useRef(null);

  if (dictationErrorPillHandoffRef.current === null) {
    dictationErrorPillHandoffRef.current = createDictationErrorPillHandoff({
      onSuppressedChange: setDictationErrorPillHandoffActive,
      shouldAutoHide: () => useSettingsStore.getState().floatingIconAutoHide,
      hideWindow: () => window.electronAPI?.hideWindow?.(),
    });
  }

  // Floating icon auto-hide setting (read from store, synced via IPC)
  const floatingIconAutoHide = useSettingsStore((s) => s.floatingIconAutoHide);
  const panelStartPosition = useSettingsStore((s) => s.panelStartPosition);
  const beamTheme = useSettingsStore((s) => s.theme);
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

  useLayoutEffect(() => {
    dictationErrorActionCountRef.current = dictationErrorActionCount;
    if (dictationErrorActionCount > 0) {
      dictationErrorPillHandoffRef.current.suppress();
    }
  }, [dictationErrorActionCount]);

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
    const root = document.querySelector(".dictation-window");
    if (!(root instanceof HTMLElement)) return undefined;

    let frame = 0;
    let plan = null;
    const clearCompensation = () => {
      root.style.setProperty("--window-resize-compensation-x", "0px");
      root.style.setProperty("--window-resize-compensation-y", "0px");
    };
    const currentBounds = () => ({
      x: window.screenX,
      y: window.screenY,
      width: window.innerWidth,
      height: window.innerHeight,
    });
    const differsFrom = (left, right) =>
      Math.abs(left.x - right.x) > 1 ||
      Math.abs(left.y - right.y) > 1 ||
      Math.abs(left.width - right.width) > 1 ||
      Math.abs(left.height - right.height) > 1;

    const applyCompensation = (current) => {
      if (!plan) return;
      const compensation = calculateWindowAnchorCompensation(plan.bounds, current, plan.anchor);
      root.style.setProperty("--window-resize-compensation-x", `${compensation.x}px`);
      root.style.setProperty("--window-resize-compensation-y", `${compensation.y}px`);
    };

    // Chromium dispatches resize before painting the new viewport. Update the
    // anchor synchronously there so the first split setBounds frame is masked,
    // rather than waiting until the following animation frame.
    const handleRendererResize = () => {
      if (!plan) return;
      const current = currentBounds();
      plan.started = true;
      applyCompensation(current);
    };

    const sample = () => {
      frame = 0;
      if (!plan) return;
      const current = currentBounds();
      if (!plan.started && differsFrom(current, plan.initial)) plan.started = true;

      if (plan.started) {
        applyCompensation(current);

        if (!differsFrom(current, plan.bounds)) {
          plan.stableFrames += 1;
          if (plan.stableFrames >= 2) {
            plan = null;
            clearCompensation();
            return;
          }
        } else {
          plan.stableFrames = 0;
        }
      }
      frame = requestAnimationFrame(sample);
    };

    const unsubscribe = window.electronAPI?.onMainWindowWillResize?.((resize) => {
      if (!resize?.bounds || !resize?.anchor) return;
      plan = {
        bounds: resize.bounds,
        anchor: resize.anchor,
        initial: currentBounds(),
        started: false,
        stableFrames: 0,
      };
      cancelAnimationFrame(frame);
      clearCompensation();
      frame = requestAnimationFrame(sample);
    });
    window.addEventListener("resize", handleRendererResize);

    return () => {
      plan = null;
      cancelAnimationFrame(frame);
      clearCompensation();
      window.removeEventListener("resize", handleRendererResize);
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
  const [assistantPanelClosing, setAssistantPanelClosing] = useState(false);
  const [assistantErrorDownplayActive, setAssistantErrorDownplayActive] = useState(false);
  const [assistantResponseReady, setAssistantResponseReady] = useState(false);
  const [assistantThinking, setAssistantThinking] = useState(false);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantFooterPhase, setAssistantFooterPhase] = useState("pill");
  const [pendingCommand, setPendingCommand] = useState(null);
  const [panelConversationId, setPanelConversationId] = useState(null);
  const [assistantConversationResetToken, setAssistantConversationResetToken] = useState(0);
  const [liveTranscriptPanelOpen, setLiveTranscriptPanelOpen] = useState(false);
  const [liveTranscriptPanelMounted, setLiveTranscriptPanelMounted] = useState(false);
  const [liveTranscriptText, setLiveTranscriptText] = useState("");
  const [liveTranscriptMeasurementText, setLiveTranscriptMeasurementText] = useState("");
  const [liveTranscriptPhase, setLiveTranscriptPhase] = useState("listening");
  const [liveTranscriptEntrancePhase, setLiveTranscriptEntrancePhase] = useState("idle");
  const [liveTranscriptManuallyCollapsed, setLiveTranscriptManuallyCollapsed] = useState(false);
  const assistantPanelOpenRef = useRef(assistantPanelOpen);
  const assistantPanelClosingRef = useRef(false);
  const assistantContentFadeCompletedRef = useRef(false);
  const assistantConversationResetPendingRef = useRef(false);
  const assistantCloseTimerRef = useRef(null);
  const assistantOpenFrameRef = useRef(null);
  const assistantFooterTimersRef = useRef([]);
  const previousAssistantResponseReadyRef = useRef(false);
  const liveTranscriptPanelOpenRef = useRef(liveTranscriptPanelOpen);
  const liveTranscriptSuppressedRef = useRef(false);
  const liveTranscriptReopenEligibleRef = useRef(false);
  const liveTranscriptCloseTimerRef = useRef(null);
  const liveTranscriptOpenFrameRef = useRef(null);
  const liveTranscriptOpenPromiseRef = useRef(null);
  const liveTranscriptOpenGenerationRef = useRef(0);
  const liveTranscriptEntranceTimersRef = useRef([]);
  const liveTranscriptSourceTextRef = useRef("");
  const liveTranscriptContentReadyRef = useRef(false);
  const liveTranscriptTextSchedulerRef = useRef(null);
  const liveTranscriptResizePromiseRef = useRef(Promise.resolve({ success: true }));
  const liveTranscriptMeasurementResizeRef = useRef({
    revision: null,
    promise: Promise.resolve({ success: true }),
  });
  const liveTranscriptPresentationGenerationRef = useRef(0);
  const assistantOpenGenerationRef = useRef(0);
  const mainWindowResizeCoordinatorRef = useRef(null);
  const commandIdRef = useRef(0);
  const assistantSelectionContextRef = useRef(null);
  const assistantHasContentRef = useRef(false);

  if (mainWindowResizeCoordinatorRef.current === null) {
    mainWindowResizeCoordinatorRef.current = createMainWindowResizeCoordinator({
      resizeMainWindow: (sizeKey) => window.electronAPI?.resizeMainWindow?.(sizeKey),
      resizeAssistantWindowToContent: (height) =>
        window.electronAPI?.resizeAssistantWindowToContent?.(height),
    });
  }

  const requestMainWindowSize = React.useCallback(
    (sizeKey) => mainWindowResizeCoordinatorRef.current.resizeMainWindow(sizeKey),
    []
  );
  const requestLiveTranscriptHeight = React.useCallback((height, revision = null) => {
    const resize = mainWindowResizeCoordinatorRef.current.resizeAssistantWindowToContent(height);
    liveTranscriptResizePromiseRef.current = resize;
    if (revision !== null) {
      liveTranscriptMeasurementResizeRef.current = { revision, promise: resize };
    }
    return resize;
  }, []);

  if (liveTranscriptTextSchedulerRef.current === null) {
    liveTranscriptTextSchedulerRef.current = createLatestValueScheduler(
      setLiveTranscriptMeasurementText,
      LIVE_TRANSCRIPT_RENDER_INTERVAL_MS
    );
  }

  const updateLiveTranscriptText = React.useCallback((text, { immediate = false } = {}) => {
    liveTranscriptSourceTextRef.current = text;
    if (liveTranscriptContentReadyRef.current) {
      liveTranscriptTextSchedulerRef.current.push(text, { immediate });
    }
  }, []);

  const prepareBufferedLiveTranscriptText = React.useCallback(() => {
    liveTranscriptTextSchedulerRef.current.cancel();
    setLiveTranscriptMeasurementText(liveTranscriptSourceTextRef.current);
  }, []);

  const resumeLiveTranscriptText = React.useCallback(() => {
    liveTranscriptContentReadyRef.current = true;
    setLiveTranscriptMeasurementText(liveTranscriptSourceTextRef.current);
    setLiveTranscriptText(liveTranscriptSourceTextRef.current);
  }, []);

  const resetLiveTranscriptText = React.useCallback(() => {
    liveTranscriptTextSchedulerRef.current.cancel();
    liveTranscriptSourceTextRef.current = "";
    liveTranscriptContentReadyRef.current = false;
    liveTranscriptPresentationGenerationRef.current += 1;
    liveTranscriptMeasurementResizeRef.current = {
      revision: null,
      promise: Promise.resolve({ success: true }),
    };
    setLiveTranscriptText("");
    setLiveTranscriptMeasurementText("");
  }, []);

  // Pending transcript text is rendered invisibly first. Its real wrapping is
  // measured at the final panel width, the native window settles to that
  // height, and only then does the visible line update. This prevents a new
  // line from pushing the panel upward before its BrowserWindow catches up.
  useLayoutEffect(() => {
    if (!liveTranscriptPanelOpen || !liveTranscriptContentReadyRef.current) return undefined;

    const generation = ++liveTranscriptPresentationGenerationRef.current;
    let firstFrame = 0;
    let measurementFrame = 0;
    let revealFrame = 0;
    firstFrame = requestAnimationFrame(() => {
      measurementFrame = requestAnimationFrame(async () => {
        let measurementResize = null;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const pending = liveTranscriptMeasurementResizeRef.current;
          if (pending.revision === liveTranscriptMeasurementText) {
            measurementResize = pending.promise;
            break;
          }
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        const resizeResult = await (measurementResize ?? liveTranscriptResizePromiseRef.current);
        if (resizeResult?.changed) {
          await new Promise((resolve) => setTimeout(resolve, LIVE_TRANSCRIPT_SHELL_GROW_MS));
        }
        if (generation !== liveTranscriptPresentationGenerationRef.current) return;
        revealFrame = requestAnimationFrame(() => {
          if (generation === liveTranscriptPresentationGenerationRef.current) {
            setLiveTranscriptText(liveTranscriptMeasurementText);
          }
        });
      });
    });

    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(measurementFrame);
      cancelAnimationFrame(revealFrame);
    };
  }, [liveTranscriptMeasurementText, liveTranscriptPanelOpen]);

  const clearLiveTranscriptEntranceTimers = React.useCallback(() => {
    for (const timer of liveTranscriptEntranceTimersRef.current) clearTimeout(timer);
    liveTranscriptEntranceTimersRef.current = [];
  }, []);

  const clearAssistantFooterTimers = React.useCallback(() => {
    for (const timer of assistantFooterTimersRef.current) clearTimeout(timer);
    assistantFooterTimersRef.current = [];
  }, []);

  const prepareFreshAssistantConversation = React.useCallback(() => {
    if (!assistantConversationResetPendingRef.current) return;
    assistantConversationResetPendingRef.current = false;
    assistantHasContentRef.current = false;
    setAssistantConversationResetToken((current) => current + 1);
  }, []);

  useLayoutEffect(() => {
    assistantPanelOpenRef.current = assistantPanelOpen;
  }, [assistantPanelOpen]);

  useLayoutEffect(() => {
    liveTranscriptPanelOpenRef.current = liveTranscriptPanelOpen;
  }, [liveTranscriptPanelOpen]);

  useEffect(() => {
    clearAssistantFooterTimers();

    if (!assistantPanelMounted || !assistantPanelOpen) {
      previousAssistantResponseReadyRef.current = false;
      setAssistantFooterPhase("pill");
      return;
    }

    if (assistantResponseReady === previousAssistantResponseReadyRef.current) return;
    previousAssistantResponseReadyRef.current = assistantResponseReady;

    const timeline = getAssistantFooterTransitionTimeline(assistantResponseReady);
    setAssistantFooterPhase(timeline.initialPhase);
    assistantFooterTimersRef.current = [
      setTimeout(() => setAssistantFooterPhase(timeline.handoffPhase), timeline.handoffAtMs),
      setTimeout(() => setAssistantFooterPhase(timeline.settledPhase), timeline.settledAtMs),
    ];

    return clearAssistantFooterTimers;
  }, [
    assistantPanelMounted,
    assistantPanelOpen,
    assistantResponseReady,
    clearAssistantFooterTimers,
  ]);

  const openAssistantPanel = React.useCallback(async () => {
    setAssistantThinking(false);
    if (assistantPanelOpenRef.current) return;
    // A closed panel starts a new keyed AssistantPanel instance. Do this only
    // when the next panel is about to open, never while the old surface is
    // contracting, so chat teardown cannot disturb the close compositor.
    prepareFreshAssistantConversation();
    const generation = ++assistantOpenGenerationRef.current;
    assistantPanelOpenRef.current = true;
    assistantPanelClosingRef.current = false;
    assistantContentFadeCompletedRef.current = false;
    setAssistantErrorDownplayActive(false);
    setAssistantPanelClosing(false);
    setAssistantResponseReady(false);
    clearTimeout(assistantCloseTimerRef.current);
    // Grow the window before the panel mounts so its entrance never paints
    // clipped inside the compact pill bounds.
    await requestMainWindowSize("ASSISTANT");
    if (generation !== assistantOpenGenerationRef.current || !assistantPanelOpenRef.current) {
      return;
    }
    setAssistantPanelMounted(true);
    cancelAnimationFrame(assistantOpenFrameRef.current);
    assistantOpenFrameRef.current = requestAnimationFrame(() => {
      assistantOpenFrameRef.current = requestAnimationFrame(() => {
        if (generation !== assistantOpenGenerationRef.current) return;
        setAssistantPanelOpen(true);
      });
    });
  }, [prepareFreshAssistantConversation, requestMainWindowSize]);

  useEffect(
    () => () => {
      clearTimeout(assistantCloseTimerRef.current);
      cancelAnimationFrame(assistantOpenFrameRef.current);
      clearAssistantFooterTimers();
      clearTimeout(liveTranscriptCloseTimerRef.current);
      cancelAnimationFrame(liveTranscriptOpenFrameRef.current);
      clearLiveTranscriptEntranceTimers();
      liveTranscriptTextSchedulerRef.current.cancel();
      mainWindowResizeCoordinatorRef.current?.dispose();
      dictationErrorPillHandoffRef.current?.cancel();
    },
    [clearAssistantFooterTimers, clearLiveTranscriptEntranceTimers]
  );

  const beginAssistantThinking = React.useCallback(() => {
    clearTimeout(assistantCloseTimerRef.current);
    assistantPanelClosingRef.current = false;
    assistantContentFadeCompletedRef.current = false;
    setAssistantPanelClosing(false);
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
      prepareFreshAssistantConversation();
      commandIdRef.current += 1;
      beginAssistantThinking();
      setPendingCommand({
        id: commandIdRef.current,
        text: command.text,
        attachment: command.attachment ?? null,
        selectedContext: command.selectedContext ?? null,
      });
    },
    [beginAssistantThinking, prepareFreshAssistantConversation]
  );

  const handleAssistantResponseContent = React.useCallback(() => {
    assistantHasContentRef.current = true;
    setAssistantThinking(false);
    void openAssistantPanel();
  }, [openAssistantPanel]);

  const handleCommandConsumed = React.useCallback((id) => {
    setPendingCommand((current) => (current?.id === id ? null : current));
  }, []);

  const handleAssistantSelectionContextChange = React.useCallback((context) => {
    assistantSelectionContextRef.current = context;
  }, []);

  const getAssistantSelectionContext = React.useCallback(
    () => assistantSelectionContextRef.current,
    []
  );

  const assistantOwnsNativeWindow =
    assistantPanelOpen || (assistantErrorDownplayActive && dictationErrorActionCount > 0);

  useEffect(() => {
    window.electronAPI?.setAssistantPanelOpen?.(assistantOwnsNativeWindow);
    if (assistantPanelOpen) setIsHovered(false);
  }, [assistantOwnsNativeWindow, assistantPanelOpen]);

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

  const handlePanelPreferredHeight = React.useCallback(
    (height, revision) => requestLiveTranscriptHeight(height, revision),
    [requestLiveTranscriptHeight]
  );

  const handleDictationError = React.useCallback((options = {}) => {
    if (typeof options.recoverAssistant === "boolean") {
      const restoreAssistantContent = options.recoverAssistant && assistantHasContentRef.current;
      assistantErrorDownplayRequestedRef.current =
        options.recoverAssistant && !assistantHasContentRef.current;

      if (restoreAssistantContent) {
        // The failed follow-up never reaches chat streaming, so no later event
        // would clear the temporary thinking flourish. The error is an overlay,
        // not replacement content: end only that transient presentation and
        // leave the response, conversation, geometry, and controls untouched.
        setAssistantThinking(false);
      }
    }

    // Errors replace the live transcript surface, so unmount it immediately
    // and suppress late preview events until the next recording begins.
    liveTranscriptSuppressedRef.current = true;
    liveTranscriptOpenGenerationRef.current += 1;
    setLiveTranscriptManuallyCollapsed(false);
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
    isPreparing,
    isStopping,
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
    getAssistantSelectionContext,
  });
  const isVisuallyProcessing = isProcessing || isPreparing || isStopping;

  useLayoutEffect(() => {
    liveTranscriptReopenEligibleRef.current = shouldOfferLiveTranscriptReopen({
      manuallyCollapsed: true,
      isRecording,
      isProcessing,
      isAssistantVoice,
    });
  }, [isAssistantVoice, isProcessing, isRecording]);

  // Direction is part of the interaction's geometry, not a live decoration.
  // Hold the origin through processing and panel exit so every close animation
  // returns to the same side from which that voice session started.
  const voiceDirectionLocked =
    isRecording || isVisuallyProcessing || assistantPanelMounted || liveTranscriptPanelMounted;
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

  const completeAssistantContentFade = React.useCallback(() => {
    if (!assistantPanelClosingRef.current || assistantContentFadeCompletedRef.current) return;
    assistantContentFadeCompletedRef.current = true;
    assistantPanelOpenRef.current = false;
    setAssistantPanelOpen(false);
    setAssistantResponseReady(false);
    setAssistantThinking(false);
    setAssistantBusy(false);
    setPendingCommand(null);
    // Closing ends the panel session without deleting its saved history. Mark
    // the next instance as fresh, but leave the current content untouched
    // until the compositor has finished contracting the surface.
    assistantSelectionContextRef.current = null;
    assistantHasContentRef.current = false;
    assistantConversationResetPendingRef.current = true;
    setPanelConversationId(null);
    clearTimeout(assistantCloseTimerRef.current);
    assistantCloseTimerRef.current = setTimeout(() => {
      assistantPanelClosingRef.current = false;
      setAssistantPanelClosing(false);
      setAssistantPanelMounted(false);
    }, ASSISTANT_TRANSITION_MS);
  }, []);

  const beginAssistantPanelClose = React.useCallback((preserveNativeOwnership = false) => {
    // Dismissing the panel mid-command must also abandon the command, or its
    // completion reopens the panel and answers a question the user withdrew.
    if (isAssistantVoice) {
      if (isRecording || isPreparing) cancelRecording();
      else if (isProcessing) cancelProcessing();
    }
    cancelAnimationFrame(assistantOpenFrameRef.current);
    assistantOpenGenerationRef.current += 1;
    clearTimeout(assistantCloseTimerRef.current);
    assistantPanelClosingRef.current = true;
    assistantContentFadeCompletedRef.current = false;
    setAssistantErrorDownplayActive(preserveNativeOwnership);
    setAssistantPanelClosing(true);

    // Native interaction ownership must be released at close intent, not after
    // the renderer's opacity transition. If the transition event is delayed or
    // dropped, keeping this flag true makes the compact pill look closed while
    // the main process still rejects hide and ordinary dictation requests.
    if (!preserveNativeOwnership) {
      void window.electronAPI?.setAssistantPanelOpen?.(false);
    }

    // VoiceModePanelCore reports the actual content fade when it can. Keep the
    // lifecycle owner here as a final guarantee so a missed child transition
    // can never strand Agent Mode in its closing state.
    assistantCloseTimerRef.current = setTimeout(
      completeAssistantContentFade,
      ASSISTANT_CONTENT_FADE_FALLBACK_MS
    );
  }, [
    isAssistantVoice,
    isRecording,
    isPreparing,
    isProcessing,
    cancelRecording,
    cancelProcessing,
    completeAssistantContentFade,
  ]);

  const handleAssistantPanelClose = React.useCallback(() => {
    beginAssistantPanelClose(false);
  }, [beginAssistantPanelClose]);

  useEffect(() => {
    if (dictationErrorActionCount > 0) {
      if (!assistantErrorDownplayRequestedRef.current) return;
      assistantErrorDownplayRequestedRef.current = false;
      beginAssistantPanelClose(true);
      return;
    }

    if (assistantErrorDownplayActive) {
      setAssistantErrorDownplayActive(false);
    }
  }, [assistantErrorDownplayActive, beginAssistantPanelClose, dictationErrorActionCount]);

  const closeLiveTranscriptPanel = React.useCallback(
    ({ suppress = false, clear = false } = {}) => {
      if (suppress) {
        liveTranscriptSuppressedRef.current = true;
        setLiveTranscriptManuallyCollapsed(liveTranscriptReopenEligibleRef.current);
      }
      if (clear) {
        setLiveTranscriptManuallyCollapsed(false);
      }
      if (clear) liveTranscriptTextSchedulerRef.current.flush();
      liveTranscriptOpenGenerationRef.current += 1;
      cancelAnimationFrame(liveTranscriptOpenFrameRef.current);
      clearLiveTranscriptEntranceTimers();
      liveTranscriptPanelOpenRef.current = false;
      setLiveTranscriptPanelOpen(false);
      setLiveTranscriptEntrancePhase("idle");
      liveTranscriptContentReadyRef.current = false;
      liveTranscriptTextSchedulerRef.current.cancel();
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
    const generation = ++liveTranscriptOpenGenerationRef.current;
    // Reserve adaptive sizing immediately. The generic size ladder must not
    // issue a recording/assistant resize while this entrance is awaiting the
    // native compositor.
    liveTranscriptPanelOpenRef.current = true;
    liveTranscriptOpenPromiseRef.current = (async () => {
      // Live Transcript owns an adaptive footprint. Enter at its footer-sized
      // surface instead of flashing the full Agent window before measurement.
      await requestLiveTranscriptHeight(LIVE_TRANSCRIPT_SURFACE_LIMITS.minHeight);
      if (
        generation !== liveTranscriptOpenGenerationRef.current ||
        liveTranscriptSuppressedRef.current ||
        assistantPanelOpenRef.current
      ) {
        if (generation === liveTranscriptOpenGenerationRef.current) {
          liveTranscriptPanelOpenRef.current = false;
        }
        return;
      }
      setIsHovered(false);
      setLiveTranscriptManuallyCollapsed(false);
      liveTranscriptContentReadyRef.current = false;
      liveTranscriptTextSchedulerRef.current.cancel();
      setLiveTranscriptText("");
      setLiveTranscriptEntrancePhase("encapsulate");
      setLiveTranscriptPanelMounted(true);
      cancelAnimationFrame(liveTranscriptOpenFrameRef.current);
      liveTranscriptOpenFrameRef.current = requestAnimationFrame(() => {
        if (generation !== liveTranscriptOpenGenerationRef.current) return;
        setLiveTranscriptPanelOpen(true);
        const timeline = getLiveTranscriptEntranceTimeline();
        liveTranscriptEntranceTimersRef.current = [
          setTimeout(() => setLiveTranscriptEntrancePhase("horizontal"), timeline.horizontalAtMs),
          setTimeout(() => setLiveTranscriptEntrancePhase("controls"), timeline.controlsAtMs),
          setTimeout(() => {
            prepareBufferedLiveTranscriptText();
            setLiveTranscriptEntrancePhase("prepare");
          }, timeline.prepareAtMs),
        ];

        const finishEntrance = setTimeout(async () => {
          // ResizeObserver has now seen the hidden buffered transcript. Wait
          // for its latest native resize rather than guessing that a fixed
          // measurement delay was long enough on this computer.
          await liveTranscriptResizePromiseRef.current;
          if (generation !== liveTranscriptOpenGenerationRef.current) return;
          setLiveTranscriptEntrancePhase("panel");

          const contentTimer = setTimeout(() => {
            if (generation !== liveTranscriptOpenGenerationRef.current) return;
            setLiveTranscriptEntrancePhase("content");
          }, LIVE_TRANSCRIPT_ENTRANCE_TIMING.panelExpansionMs + LIVE_TRANSCRIPT_ENTRANCE_TIMING.contentRevealDelayMs);
          const streamTimer = setTimeout(
            () => {
              if (generation !== liveTranscriptOpenGenerationRef.current) return;
              resumeLiveTranscriptText();
            },
            LIVE_TRANSCRIPT_ENTRANCE_TIMING.panelExpansionMs +
              LIVE_TRANSCRIPT_ENTRANCE_TIMING.contentRevealDelayMs +
              LIVE_TRANSCRIPT_ENTRANCE_TIMING.contentSettleMs
          );
          liveTranscriptEntranceTimersRef.current.push(contentTimer, streamTimer);
        }, timeline.panelAtMs);
        liveTranscriptEntranceTimersRef.current.push(finishEntrance);
      });
    })().finally(() => {
      liveTranscriptOpenPromiseRef.current = null;
    });
  }, [
    clearLiveTranscriptEntranceTimers,
    prepareBufferedLiveTranscriptText,
    requestLiveTranscriptHeight,
    resumeLiveTranscriptText,
  ]);

  const reopenLiveTranscriptPanel = React.useCallback(() => {
    liveTranscriptSuppressedRef.current = false;
    openLiveTranscriptPanel();
  }, [openLiveTranscriptPanel]);

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
      setLiveTranscriptManuallyCollapsed(false);
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

  useEffect(() => {
    if (!isAssistantVoice && (isRecording || isProcessing)) return;
    setLiveTranscriptManuallyCollapsed(false);
  }, [isAssistantVoice, isProcessing, isRecording]);

  // Single owner of the window size: panel > menu > toast > compact pill > base.
  // Grows apply immediately so content never clips; shrinks wait for the
  // content collapse animation to finish before the window snaps down.
  const voiceActivity = resolveVoiceActivityPresentation({
    isRecording,
    isProcessing: isVisuallyProcessing,
    isAssistantVoice,
    assistantThinking: assistantThinking || assistantBusy,
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
  const panelSizeReservationRef = useRef(false);
  useEffect(() => {
    const panelOwnsWindow =
      assistantPanelOpenRef.current ||
      liveTranscriptPanelOpenRef.current ||
      assistantPanelMounted ||
      liveTranscriptPanelMounted;
    if (panelOwnsWindow) {
      panelSizeReservationRef.current = true;
      return undefined;
    }

    const returningFromPanel = panelSizeReservationRef.current;
    panelSizeReservationRef.current = false;
    const target = resolveMainWindowSizeKey({
      panelOpen: false,
      menuOpen: isCommandMenuOpen,
      toastCount,
      compactPill: isCompactPill,
      dictationErrorActionCount,
    });
    const prev = lastSizeKeyRef.current;
    lastSizeKeyRef.current = target;
    if (target === prev && !returningFromPanel) return undefined;
    if (target === "DICTATION_ERROR" || target === "DICTATION_ERROR_WITH_TRANSCRIPT") {
      // Establish the final width immediately. The hidden error card then
      // measures wrapping at that width and performs one content-height resize.
      void requestMainWindowSize(target);
      return undefined;
    }
    if (prev === "DICTATION_ERROR" || prev === "DICTATION_ERROR_WITH_TRANSCRIPT") {
      // Keep the same pill root hidden until Electron has restored the compact
      // bounds. Revealing it in the old error footprint makes it jump once when
      // React mounts it and again when the native resize reaches Chromium.
      void dictationErrorPillHandoffRef.current.releaseAfter(async () => {
        let settledTarget = target;
        await requestMainWindowSize(settledTarget);
        // A menu/toast edge can supersede BASE while its native resize is
        // queued. Follow the size owner's latest target before revealing.
        while (
          dictationErrorActionCountRef.current === 0 &&
          lastSizeKeyRef.current !== settledTarget
        ) {
          settledTarget = lastSizeKeyRef.current;
          await requestMainWindowSize(settledTarget);
        }
      });
      return undefined;
    }
    if (returningFromPanel || !prev || SIZE_RANK[target] >= SIZE_RANK[prev]) {
      void requestMainWindowSize(target);
      return undefined;
    }
    const timeout = setTimeout(() => void requestMainWindowSize(target), 340);
    return () => clearTimeout(timeout);
  }, [
    assistantPanelOpen,
    assistantPanelMounted,
    liveTranscriptPanelOpen,
    liveTranscriptPanelMounted,
    isCommandMenuOpen,
    toastCount,
    isCompactPill,
    dictationErrorActionCount,
    requestMainWindowSize,
  ]);

  useEffect(() => {
    if (isRecording && dictationErrorActionCount > 0) {
      dismissByPresentation("dictation-error");
    }
  }, [isRecording, dictationErrorActionCount, dismissByPresentation]);

  useEffect(() => {
    if (
      dictationErrorActionCount > 0 ||
      !dictationErrorPillHandoffActive ||
      (!assistantPanelMounted && !liveTranscriptPanelMounted)
    ) {
      return;
    }

    // A panel already owns stable native bounds, so an error displayed inside
    // it has no compact resize to await. Release only the visual suppression.
    void dictationErrorPillHandoffRef.current.releaseAfter(async () => {});
  }, [
    assistantPanelMounted,
    dictationErrorActionCount,
    dictationErrorPillHandoffActive,
    liveTranscriptPanelMounted,
  ]);

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
      !isVisuallyProcessing &&
      toastCount === 0 &&
      !dictationErrorPillHandoffActive &&
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
    isVisuallyProcessing,
    floatingIconAutoHide,
    toastCount,
    dictationErrorPillHandoffActive,
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
    assistantPanelMounted,
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
  const anyPanelOpen = assistantPanelOpen || liveTranscriptPanelOpen;
  const anyPanelMounted = assistantPanelMounted || liveTranscriptPanelMounted;
  const canReopenLiveTranscript =
    shouldOfferLiveTranscriptReopen({
      manuallyCollapsed: liveTranscriptManuallyCollapsed,
      isRecording,
      isProcessing,
      isAssistantVoice,
    }) && !anyPanelMounted;
  const agentModeActive = resolveAgentModeActive({
    isAssistantVoice,
    isRecording,
    isProcessing: isVisuallyProcessing,
    assistantPanelMounted,
  });
  const assistantFooter = resolveAssistantFooterPresentation(assistantFooterPhase);
  const pillIsInteractive = !liveTranscriptPanelMounted;
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
        (assistantPanelOpen ? (isHovered ? "hover" : "idle") : micState);
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
  const dictationErrorSuppressesPill =
    dictationErrorActionCount > 0 || dictationErrorPillHandoffActive;
  // Keep one pill DOM node alive while final Agent actions own the footer. On
  // close it can fade and travel from the panel dock instead of mounting at
  // the resting dock halfway through the surface contraction.
  const assistantActionsSuppressPill = assistantPanelOpen && !assistantFooter.pillVisible;
  const pillVisuallySuppressed = dictationErrorSuppressesPill || assistantActionsSuppressPill;
  const pillInteractionSuppressed = pillVisuallySuppressed || assistantPanelClosing;

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
          data-assistant-footer-phase={assistantPanelOpen ? assistantFooterPhase : undefined}
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
            if (!pillIsInteractive) return;
            setIsHovered(false);
            if (!isCommandMenuOpen && !assistantPanelMounted) {
              setWindowInteractivity(false);
            }
          }}
        >
          <Tooltip
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
              beamActive={listeningEntrance.beamActive ?? undefined}
              waveformVisible={listeningEntrance.waveformVisible}
              waveformOnlyWhileRecording={anyPanelMounted}
              integratedWithPanel={liveTranscriptPanelOpen}
              agentMode={agentModeActive}
              beamTheme={beamTheme}
              showExpandChevron={canReopenLiveTranscript && isHovered}
              getAudioLevel={getAudioLevel}
              isDragging={isDragging}
              horizontalDirection={voiceHorizontalDirection}
              role={pillIsInteractive ? "button" : "status"}
              aria-label={
                canReopenLiveTranscript
                  ? t("transcriptionPreview.label")
                  : assistantPanelMounted
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
                if (!pillIsInteractive) return;
                if (canReopenLiveTranscript) {
                  reopenLiveTranscriptPanel();
                } else if (
                  !hasDragged &&
                  micState !== "processing" &&
                  !voiceActivity.isAgentThinking
                ) {
                  setIsCommandMenuOpen(false);
                  toggleListening({ voiceAgentRequested: assistantPanelMounted });
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

      <VoiceModePanelCore
        mode={activeVoicePanelMode}
        open={activeVoicePanel.open}
        closing={activeVoicePanelMode === "assistant" && assistantPanelClosing}
        stage={
          activeVoicePanelMode === "live-transcript" ? liveTranscriptEntrance.coreStage : "content"
        }
        horizontalDirection={voiceHorizontalDirection}
        label={activeVoicePanelLabel}
        measurementRevision={
          activeVoicePanelMode === "live-transcript" ? liveTranscriptMeasurementText : null
        }
        onPreferredHeightChange={handlePanelPreferredHeight}
        onClosingFadeComplete={completeAssistantContentFade}
      >
        {activeVoicePanelMode === "assistant" && assistantPanelMounted && (
          <AssistantPanel
            key={assistantConversationResetToken}
            pendingCommand={pendingCommand}
            onCommandConsumed={handleCommandConsumed}
            initialConversationId={panelConversationId}
            onConversationIdChange={setPanelConversationId}
            voiceState={assistantVoiceState}
            thinking={assistantThinking && assistantPanelOpen}
            open={assistantPanelOpen}
            footerPhase={assistantFooterPhase}
            horizontalDirection={voiceHorizontalDirection}
            onClose={handleAssistantPanelClose}
            onBusyChange={setAssistantBusy}
            onResponseReadyChange={setAssistantResponseReady}
            onResponseContent={handleAssistantResponseContent}
            onSelectionContextChange={handleAssistantSelectionContextChange}
          />
        )}

        {activeVoicePanelMode !== "assistant" && (
          <LiveTranscriptPanel
            text={liveTranscriptPanelMounted ? liveTranscriptText : ""}
            measurementText={liveTranscriptPanelMounted ? liveTranscriptMeasurementText : ""}
            phase={liveTranscriptPhase}
            processing={liveTranscriptPanelMounted && isProcessing && !isAssistantVoice}
            controlsVisible={liveTranscriptPanelMounted && liveTranscriptEntrance.controlsVisible}
            contentVisible={liveTranscriptPanelMounted && liveTranscriptEntrance.contentVisible}
            onCollapse={() => closeLiveTranscriptPanel({ suppress: true })}
          />
        )}
      </VoiceModePanelCore>
    </div>
  );
}
