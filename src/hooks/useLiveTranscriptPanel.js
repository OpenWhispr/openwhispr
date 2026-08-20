import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createLatestValueScheduler } from "../utils/latestValueScheduler";
import {
  getLiveTranscriptEntranceTimeline,
  LIVE_TRANSCRIPT_ENTRANCE_TIMING,
  LIVE_TRANSCRIPT_SURFACE_LIMITS,
  shouldOfferLiveTranscriptReopen,
} from "../helpers/voicePillPresentation";

const LIVE_TRANSCRIPT_RENDER_INTERVAL_MS = 50;
const LIVE_TRANSCRIPT_SHELL_GROW_MS = 180;
const LIVE_TRANSCRIPT_CLOSE_UNMOUNT_MS = 320;
const LIVE_TRANSCRIPT_FINAL_HIDE_MS = 4000;

/**
 * Owns the live transcript panel: its open/close/entrance choreography, the
 * buffered text scheduler, and the measure-then-reveal pipeline that keeps a
 * new transcript line from pushing the panel up before its BrowserWindow
 * catches up. The assistant panel always wins the shared surface, checked
 * through `assistantOpenRef`.
 */
export function useLiveTranscriptPanel({
  resizeToContent,
  assistantOpenRef,
  onWillOpen,
  isRecording,
  isProcessing,
  isAssistantVoice,
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [text, setText] = useState("");
  const [measurementText, setMeasurementText] = useState("");
  const [phase, setPhase] = useState("listening");
  const [entrancePhase, setEntrancePhase] = useState("idle");
  const [manuallyCollapsed, setManuallyCollapsed] = useState(false);

  const openRef = useRef(open);
  const suppressedRef = useRef(false);
  const reopenEligibleRef = useRef(false);
  const closeTimerRef = useRef(null);
  const finalHideTimerRef = useRef(null);
  const finalHoldRef = useRef(false);
  const phaseRef = useRef("listening");
  const openFrameRef = useRef(null);
  const openPromiseRef = useRef(null);
  const openGenerationRef = useRef(0);
  const entranceTimersRef = useRef([]);
  const sourceTextRef = useRef("");
  const contentReadyRef = useRef(false);
  const textSchedulerRef = useRef(null);
  const resizePromiseRef = useRef(Promise.resolve({ success: true }));
  const measurementResizeRef = useRef({
    revision: null,
    promise: Promise.resolve({ success: true }),
  });
  const presentationGenerationRef = useRef(0);

  if (textSchedulerRef.current === null) {
    textSchedulerRef.current = createLatestValueScheduler(
      setMeasurementText,
      LIVE_TRANSCRIPT_RENDER_INTERVAL_MS
    );
  }

  useLayoutEffect(() => {
    openRef.current = open;
  }, [open]);

  useLayoutEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const requestHeight = useCallback(
    (height, revision = null) => {
      const resize = resizeToContent(height);
      resizePromiseRef.current = resize;
      if (revision !== null) {
        measurementResizeRef.current = { revision, promise: resize };
      }
      return resize;
    },
    [resizeToContent]
  );

  const updateText = useCallback((value, { immediate = false } = {}) => {
    sourceTextRef.current = value;
    if (contentReadyRef.current) {
      textSchedulerRef.current.push(value, { immediate });
    }
  }, []);

  const prepareBufferedText = useCallback(() => {
    textSchedulerRef.current.cancel();
    setMeasurementText(sourceTextRef.current);
  }, []);

  const resumeText = useCallback(() => {
    contentReadyRef.current = true;
    setMeasurementText(sourceTextRef.current);
    setText(sourceTextRef.current);
  }, []);

  const resetText = useCallback(() => {
    textSchedulerRef.current.cancel();
    sourceTextRef.current = "";
    contentReadyRef.current = false;
    presentationGenerationRef.current += 1;
    measurementResizeRef.current = {
      revision: null,
      promise: Promise.resolve({ success: true }),
    };
    setText("");
    setMeasurementText("");
  }, []);

  // Pending transcript text is rendered invisibly first. Its real wrapping is
  // measured at the final panel width, the native window settles to that
  // height, and only then does the visible line update. This prevents a new
  // line from pushing the panel upward before its BrowserWindow catches up.
  useLayoutEffect(() => {
    if (!open || !contentReadyRef.current) return undefined;

    const generation = ++presentationGenerationRef.current;
    let firstFrame = 0;
    let measurementFrame = 0;
    let revealFrame = 0;
    firstFrame = requestAnimationFrame(() => {
      measurementFrame = requestAnimationFrame(async () => {
        let measurementResize = null;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const pending = measurementResizeRef.current;
          if (pending.revision === measurementText) {
            measurementResize = pending.promise;
            break;
          }
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        const resizeResult = await (measurementResize ?? resizePromiseRef.current);
        if (resizeResult?.changed) {
          await new Promise((resolve) => setTimeout(resolve, LIVE_TRANSCRIPT_SHELL_GROW_MS));
        }
        if (generation !== presentationGenerationRef.current) return;
        revealFrame = requestAnimationFrame(() => {
          if (generation === presentationGenerationRef.current) {
            setText(measurementText);
          }
        });
      });
    });

    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(measurementFrame);
      cancelAnimationFrame(revealFrame);
    };
  }, [measurementText, open]);

  const clearEntranceTimers = useCallback(() => {
    for (const timer of entranceTimersRef.current) clearTimeout(timer);
    entranceTimersRef.current = [];
  }, []);

  const clearFinalHide = useCallback(() => {
    clearTimeout(finalHideTimerRef.current);
    finalHideTimerRef.current = null;
  }, []);

  const close = useCallback(
    ({ suppress = false, clear = false } = {}) => {
      clearFinalHide();
      finalHoldRef.current = false;
      if (suppress) {
        suppressedRef.current = true;
        setManuallyCollapsed(reopenEligibleRef.current);
      }
      if (clear) {
        setManuallyCollapsed(false);
        textSchedulerRef.current.flush();
      }
      openGenerationRef.current += 1;
      cancelAnimationFrame(openFrameRef.current);
      clearEntranceTimers();
      openRef.current = false;
      setOpen(false);
      setEntrancePhase("idle");
      contentReadyRef.current = false;
      textSchedulerRef.current.cancel();
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = setTimeout(() => {
        setMounted(false);
        if (clear) {
          resetText();
          setPhase("listening");
        }
      }, LIVE_TRANSCRIPT_CLOSE_UNMOUNT_MS);
    },
    [clearEntranceTimers, clearFinalHide, resetText]
  );

  const openPanel = useCallback(() => {
    clearFinalHide();
    if (suppressedRef.current || assistantOpenRef.current || openRef.current) {
      return;
    }
    if (openPromiseRef.current) return;

    clearTimeout(closeTimerRef.current);
    clearEntranceTimers();
    const generation = ++openGenerationRef.current;
    // Reserve adaptive sizing immediately. The generic size ladder must not
    // issue a recording/assistant resize while this entrance is awaiting the
    // native compositor.
    openRef.current = true;
    const openPromise = (async () => {
      // Live Transcript owns an adaptive footprint. Enter at its footer-sized
      // surface instead of flashing the full Agent window before measurement.
      await requestHeight(LIVE_TRANSCRIPT_SURFACE_LIMITS.minHeight);
      if (
        generation !== openGenerationRef.current ||
        suppressedRef.current ||
        assistantOpenRef.current
      ) {
        if (generation === openGenerationRef.current) {
          openRef.current = false;
        }
        return;
      }
      onWillOpen?.();
      setManuallyCollapsed(false);
      contentReadyRef.current = false;
      textSchedulerRef.current.cancel();
      setText("");
      setEntrancePhase("encapsulate");
      setMounted(true);
      cancelAnimationFrame(openFrameRef.current);
      openFrameRef.current = requestAnimationFrame(() => {
        if (generation !== openGenerationRef.current) return;
        setOpen(true);
        const timeline = getLiveTranscriptEntranceTimeline();
        entranceTimersRef.current = [
          setTimeout(() => setEntrancePhase("horizontal"), timeline.horizontalAtMs),
          setTimeout(() => setEntrancePhase("controls"), timeline.controlsAtMs),
          setTimeout(() => {
            prepareBufferedText();
            setEntrancePhase("prepare");
          }, timeline.prepareAtMs),
        ];

        const finishEntrance = setTimeout(async () => {
          // ResizeObserver has now seen the hidden buffered transcript. Wait
          // for its latest native resize rather than guessing that a fixed
          // measurement delay was long enough on this computer.
          await resizePromiseRef.current;
          if (generation !== openGenerationRef.current) return;
          setEntrancePhase("panel");

          const contentTimer = setTimeout(() => {
            if (generation !== openGenerationRef.current) return;
            setEntrancePhase("content");
          }, LIVE_TRANSCRIPT_ENTRANCE_TIMING.panelExpansionMs + LIVE_TRANSCRIPT_ENTRANCE_TIMING.contentRevealDelayMs);
          const streamTimer = setTimeout(
            () => {
              if (generation !== openGenerationRef.current) return;
              resumeText();
            },
            LIVE_TRANSCRIPT_ENTRANCE_TIMING.panelExpansionMs +
              LIVE_TRANSCRIPT_ENTRANCE_TIMING.contentRevealDelayMs +
              LIVE_TRANSCRIPT_ENTRANCE_TIMING.contentSettleMs
          );
          entranceTimersRef.current.push(contentTimer, streamTimer);
        }, timeline.panelAtMs);
        entranceTimersRef.current.push(finishEntrance);
      });
    })().catch(() => {
      if (generation === openGenerationRef.current) openRef.current = false;
    });
    openPromiseRef.current = openPromise;
    void openPromise.finally(() => {
      if (openPromiseRef.current === openPromise) {
        openPromiseRef.current = null;
      }
    });
  }, [
    assistantOpenRef,
    clearEntranceTimers,
    clearFinalHide,
    onWillOpen,
    prepareBufferedText,
    requestHeight,
    resumeText,
  ]);

  const reopen = useCallback(() => {
    suppressedRef.current = false;
    openPanel();
  }, [openPanel]);

  const scheduleFinalHide = useCallback(() => {
    clearFinalHide();
    finalHideTimerRef.current = setTimeout(() => {
      finalHideTimerRef.current = null;
      if (finalHoldRef.current || phaseRef.current !== "final" || !openRef.current) return;
      close({ clear: true });
    }, LIVE_TRANSCRIPT_FINAL_HIDE_MS);
  }, [clearFinalHide, close]);

  const holdFinal = useCallback(
    (held) => {
      finalHoldRef.current = held;
      if (held) {
        clearFinalHide();
        return;
      }
      if (phaseRef.current === "final" && openRef.current && finalHideTimerRef.current === null) {
        scheduleFinalHide();
      }
    },
    [clearFinalHide, scheduleFinalHide]
  );

  const showFinalText = useCallback(
    (value) => {
      const finalText = typeof value === "string" ? value.trim() : "";
      if (!finalText) return;
      suppressedRef.current = false;
      setManuallyCollapsed(false);
      updateText(finalText, { immediate: true });
      setPhase("final");
      openPanel();
      scheduleFinalHide();
    },
    [openPanel, scheduleFinalHide, updateText]
  );

  // Errors replace the live transcript surface, so unmount it immediately
  // and suppress late preview events until the next recording begins.
  const dismissForError = useCallback(() => {
    clearFinalHide();
    finalHoldRef.current = false;
    suppressedRef.current = true;
    openGenerationRef.current += 1;
    openPromiseRef.current = null;
    setManuallyCollapsed(false);
    cancelAnimationFrame(openFrameRef.current);
    clearTimeout(closeTimerRef.current);
    clearEntranceTimers();
    openRef.current = false;
    setOpen(false);
    setMounted(false);
    resetText();
    setPhase("listening");
    setEntrancePhase("idle");
  }, [clearEntranceTimers, clearFinalHide, resetText]);

  useEffect(() => {
    const reveal = () => {
      if (!suppressedRef.current) openPanel();
    };

    const disposeText = window.electronAPI?.onPreviewText?.((incoming) => {
      clearFinalHide();
      const value = incoming?.trim?.() || "";
      updateText(value);
      setPhase(value ? "live" : "listening");
      reveal();
    });
    const disposeAppend = window.electronAPI?.onPreviewAppend?.((chunk) => {
      clearFinalHide();
      const value = chunk?.trim?.();
      if (!value) return;
      const current = sourceTextRef.current;
      updateText(current ? `${current} ${value}` : value);
      setPhase("live");
      reveal();
    });
    const disposeHold = window.electronAPI?.onPreviewHold?.((payload) => {
      textSchedulerRef.current.flush();
      setPhase(payload?.showCleanup ? "cleanup" : "final");
      reveal();
    });
    const disposeResult = window.electronAPI?.onPreviewResult?.((payload) => {
      const value = payload?.text?.trim?.();
      if (!value) {
        close({ clear: true });
        return;
      }
      updateText(value, { immediate: true });
      setPhase("final");
      reveal();
      scheduleFinalHide();
    });
    const disposeHide = window.electronAPI?.onPreviewHide?.(() => {
      close({ clear: true });
    });

    return () => {
      disposeText?.();
      disposeAppend?.();
      disposeHold?.();
      disposeResult?.();
      disposeHide?.();
    };
  }, [clearFinalHide, close, openPanel, scheduleFinalHide, updateText]);

  useLayoutEffect(() => {
    reopenEligibleRef.current = shouldOfferLiveTranscriptReopen({
      manuallyCollapsed: true,
      isRecording,
      isProcessing,
      isAssistantVoice,
    });
  }, [isAssistantVoice, isProcessing, isRecording]);

  const previousNormalRecordingRef = useRef(false);
  useLayoutEffect(() => {
    const normalRecording = isRecording && !isAssistantVoice;
    if (normalRecording && !previousNormalRecordingRef.current) {
      clearFinalHide();
      finalHoldRef.current = false;
    }
  }, [clearFinalHide, isAssistantVoice, isRecording]);

  useEffect(() => {
    const normalRecording = isRecording && !isAssistantVoice;
    if (normalRecording && !previousNormalRecordingRef.current) {
      suppressedRef.current = false;
      setManuallyCollapsed(false);
      resetText();
      setPhase("listening");
    }
    previousNormalRecordingRef.current = normalRecording;

    if (isRecording && isAssistantVoice && mounted) {
      close({ clear: true });
    }
  }, [isAssistantVoice, isRecording, mounted, close, resetText]);

  useEffect(() => {
    if (!isAssistantVoice && (isRecording || isProcessing)) return;
    setManuallyCollapsed(false);
  }, [isAssistantVoice, isProcessing, isRecording]);

  useEffect(
    () => () => {
      clearTimeout(closeTimerRef.current);
      clearFinalHide();
      cancelAnimationFrame(openFrameRef.current);
      clearEntranceTimers();
      textSchedulerRef.current.cancel();
    },
    [clearEntranceTimers, clearFinalHide]
  );

  return {
    open,
    mounted,
    text,
    measurementText,
    phase,
    entrancePhase,
    manuallyCollapsed,
    openRef,
    requestHeight,
    close,
    reopen,
    holdFinal,
    showFinalText,
    dismissForError,
  };
}
