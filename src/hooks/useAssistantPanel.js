import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  getAssistantFooterTransitionTimeline,
  resolveAssistantThinkingTransition,
} from "../helpers/voicePillPresentation";
import {
  closeAssistantSessionState,
  discardPendingAssistantCommand,
} from "../helpers/assistantSessionState";

const ASSISTANT_TRANSITION_MS = 320;
const ASSISTANT_CONTENT_FADE_FALLBACK_MS = 260;

/**
 * Owns the assistant panel lifecycle: open/close choreography, the thinking
 * flourish, footer phase timeline, pending voice commands, and conversation
 * session boundaries. The caller wires it to the recording pipeline through
 * `recordingControlsRef` (read at call time, never during render) because the
 * recording hook both feeds commands into this panel and is cancelled by it.
 */
export function useAssistantPanel({
  requestMainWindowSize,
  dictationErrorActionCount,
  recordingControlsRef,
  onPanelOpened,
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  const [errorDownplayActive, setErrorDownplayActive] = useState(false);
  const [responseReady, setResponseReady] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [footerPhase, setFooterPhase] = useState("pill");
  const [pendingCommand, setPendingCommand] = useState(null);
  const [conversationId, setConversationId] = useState(null);

  const openRef = useRef(open);
  const closingRef = useRef(false);
  const contentFadeCompletedRef = useRef(false);
  const closeTimerRef = useRef(null);
  const openFrameRef = useRef(null);
  const footerTimersRef = useRef([]);
  const previousResponseReadyRef = useRef(false);
  const openGenerationRef = useRef(0);
  const commandIdRef = useRef(0);
  const conversationIdRef = useRef(conversationId);
  const selectionContextRef = useRef(null);
  const hasContentRef = useRef(false);
  const errorDownplayRequestedRef = useRef(false);

  useLayoutEffect(() => {
    openRef.current = open;
  }, [open]);

  useLayoutEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  const clearFooterTimers = useCallback(() => {
    for (const timer of footerTimersRef.current) clearTimeout(timer);
    footerTimersRef.current = [];
  }, []);

  useEffect(() => {
    clearFooterTimers();

    if (!mounted || !open) {
      previousResponseReadyRef.current = false;
      setFooterPhase("pill");
      return;
    }

    if (responseReady === previousResponseReadyRef.current) return;
    previousResponseReadyRef.current = responseReady;

    const timeline = getAssistantFooterTransitionTimeline(responseReady);
    setFooterPhase(timeline.initialPhase);
    footerTimersRef.current = [
      setTimeout(() => setFooterPhase(timeline.handoffPhase), timeline.handoffAtMs),
      setTimeout(() => setFooterPhase(timeline.settledPhase), timeline.settledAtMs),
    ];

    return clearFooterTimers;
  }, [mounted, open, responseReady, clearFooterTimers]);

  const openPanel = useCallback(async () => {
    setThinking(false);
    if (openRef.current) return;
    const generation = ++openGenerationRef.current;
    openRef.current = true;
    closingRef.current = false;
    contentFadeCompletedRef.current = false;
    setErrorDownplayActive(false);
    setClosing(false);
    setResponseReady(false);
    clearTimeout(closeTimerRef.current);
    // Grow the window before the panel mounts so its entrance never paints
    // clipped inside the compact pill bounds.
    try {
      await requestMainWindowSize("ASSISTANT");
    } catch {
      if (generation === openGenerationRef.current) openRef.current = false;
      return;
    }
    if (generation !== openGenerationRef.current || !openRef.current) {
      return;
    }
    setMounted(true);
    cancelAnimationFrame(openFrameRef.current);
    openFrameRef.current = requestAnimationFrame(() => {
      openFrameRef.current = requestAnimationFrame(() => {
        if (generation !== openGenerationRef.current) return;
        setOpen(true);
      });
    });
  }, [requestMainWindowSize]);

  const beginThinking = useCallback(() => {
    clearTimeout(closeTimerRef.current);
    closingRef.current = false;
    contentFadeCompletedRef.current = false;
    setClosing(false);
    cancelAnimationFrame(openFrameRef.current);
    const transition = resolveAssistantThinkingTransition(openRef.current);
    openRef.current = transition.panelOpen;
    setOpen(transition.panelOpen);
    setResponseReady(transition.responseReady);
    setThinking(transition.thinking);
    setMounted(transition.panelMounted);
  }, []);

  const handleCommand = useCallback(
    (command) => {
      commandIdRef.current += 1;
      // A follow-up spoken into an open panel stays panel-first: its answer is
      // already streaming into a visible conversation, and delivering it to
      // the external caret would snap that surface away mid-read.
      const delivery = openRef.current ? null : (command.delivery ?? null);
      beginThinking();
      setPendingCommand({
        id: commandIdRef.current,
        text: command.text,
        attachment: command.attachment ?? null,
        selectedContext: command.selectedContext ?? null,
        delivery,
      });
    },
    [beginThinking]
  );

  const handleResponseContent = useCallback(() => {
    hasContentRef.current = true;
    setThinking(false);
    void openPanel();
  }, [openPanel]);

  const handleConversationReset = useCallback(() => {
    hasContentRef.current = false;
    errorDownplayRequestedRef.current = false;
    setResponseReady(false);
  }, []);

  const handleCommandConsumed = useCallback((id) => {
    setPendingCommand((current) => (current?.id === id ? null : current));
  }, []);

  const handleCommandDiscarded = useCallback((id) => {
    setPendingCommand((current) => discardPendingAssistantCommand(current, id));
  }, []);

  const mountedRef = useRef(false);
  useLayoutEffect(() => {
    mountedRef.current = mounted;
  }, [mounted]);

  const handleCommandSettled = useCallback(
    (id, { showPanel = true } = {}) => {
      if (id !== commandIdRef.current) return;
      if (!mountedRef.current || closingRef.current) return;
      setThinking(false);
      if (showPanel) {
        void openPanel();
        return;
      }
      openRef.current = false;
      setOpen(false);
      setBusy(false);
      setResponseReady(false);
      setMounted(false);
    },
    [openPanel]
  );

  const handleSelectionContextChange = useCallback((context) => {
    selectionContextRef.current = context;
  }, []);

  const getSelectionContext = useCallback(() => selectionContextRef.current, []);

  const ownsNativeWindow = open || (errorDownplayActive && dictationErrorActionCount > 0);
  const assistantPanelBusy = thinking || busy || pendingCommand !== null;

  useEffect(() => {
    window.electronAPI?.setAssistantPanelOpen?.(ownsNativeWindow);
    if (open) onPanelOpened?.();
  }, [ownsNativeWindow, open, onPanelOpened]);

  useEffect(() => {
    window.electronAPI?.setAssistantPanelBusy?.(assistantPanelBusy);
  }, [assistantPanelBusy]);

  const completeContentFade = useCallback(() => {
    if (!closingRef.current || contentFadeCompletedRef.current) return;
    const closeState = closeAssistantSessionState({
      conversationId: conversationIdRef.current,
    });
    contentFadeCompletedRef.current = true;
    openRef.current = false;
    setOpen(false);
    setResponseReady(closeState.responseReady);
    setThinking(closeState.thinking);
    setBusy(closeState.busy);
    setPendingCommand(closeState.pendingCommand);
    setConversationId(closeState.conversationId);
    selectionContextRef.current = null;
    hasContentRef.current = false;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      closingRef.current = false;
      setClosing(false);
      setMounted(false);
    }, ASSISTANT_TRANSITION_MS);
  }, []);

  const beginClose = useCallback(
    (preserveNativeOwnership = false) => {
      // Dismissing the panel mid-command must also abandon the command, or its
      // completion reopens the panel and answers a question the user withdrew.
      const recording = recordingControlsRef.current;
      if (recording?.isAssistantVoice) {
        if (recording.isRecording || recording.isPreparing) recording.cancelRecording();
        else if (recording.isProcessing) recording.cancelProcessing();
      }
      cancelAnimationFrame(openFrameRef.current);
      openGenerationRef.current += 1;
      clearTimeout(closeTimerRef.current);
      closingRef.current = true;
      contentFadeCompletedRef.current = false;
      setErrorDownplayActive(preserveNativeOwnership);
      setClosing(true);

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
      closeTimerRef.current = setTimeout(completeContentFade, ASSISTANT_CONTENT_FADE_FALLBACK_MS);
    },
    [recordingControlsRef, completeContentFade]
  );

  const handleClose = useCallback(() => {
    beginClose(false);
  }, [beginClose]);

  useEffect(() => {
    if (dictationErrorActionCount > 0) {
      if (!errorDownplayRequestedRef.current) return;
      errorDownplayRequestedRef.current = false;
      beginClose(true);
      return;
    }

    if (errorDownplayActive) {
      setErrorDownplayActive(false);
    }
  }, [errorDownplayActive, beginClose, dictationErrorActionCount]);

  // The assistant slice of a dictation error: decide whether the panel rides
  // through the error (existing content) or retreats behind it (empty panel).
  const noteDictationError = useCallback((options = {}) => {
    if (typeof options.recoverAssistant !== "boolean") return;
    const restoreContent = options.recoverAssistant && hasContentRef.current;
    errorDownplayRequestedRef.current = options.recoverAssistant && !hasContentRef.current;

    if (restoreContent) {
      // The failed follow-up never reaches chat streaming, so no later event
      // would clear the temporary thinking flourish. The error is an overlay,
      // not replacement content: end only that transient presentation and
      // leave the response, conversation, geometry, and controls untouched.
      setThinking(false);
    }
  }, []);

  useEffect(
    () => () => {
      clearTimeout(closeTimerRef.current);
      cancelAnimationFrame(openFrameRef.current);
      clearFooterTimers();
    },
    [clearFooterTimers]
  );

  return {
    open,
    mounted,
    closing,
    thinking,
    busy,
    footerPhase,
    pendingCommand,
    conversationId,
    openRef,
    setBusy,
    setResponseReady,
    setConversationId,
    openPanel,
    beginThinking,
    handleCommand,
    handleResponseContent,
    handleConversationReset,
    handleCommandConsumed,
    handleCommandDiscarded,
    handleCommandSettled,
    handleSelectionContextChange,
    getSelectionContext,
    handleClose,
    completeContentFade,
    noteDictationError,
  };
}
