import { useCallback, useEffect, useRef, useState } from "react";
import { createHandsFreeTipGate, HANDS_FREE_TIP_DURATION_MS } from "../helpers/handsFreeTip";

const EXIT_MS = 200;
// A resumed countdown keeps enough runway that the card cannot vanish as the
// pointer leaves it.
const MIN_RESUME_MS = 1500;

/**
 * Offers the double-press hands-free gesture after a long hold-to-talk
 * session. Main reports the hold ending (with how long the key was held), the
 * recording hook reports the run finishing, and the tip then waits for the
 * pill to rest — no panel, toast, menu or recording owning the window.
 */
export function useHandsFreeTip({ completedRuns, recording, atRest }) {
  const gateRef = useRef(null);
  if (!gateRef.current) gateRef.current = createHandsFreeTipGate(localStorage);
  // A hold that ended but whose run has not completed yet.
  const pendingRef = useRef(null);
  // A completed run whose tip waits for the pill to rest.
  const armedRef = useRef(null);
  const seenRunsRef = useRef(completedRuns);
  const timerRef = useRef({ id: null, deadline: 0, remainingMs: 0 });
  const exitTimerRef = useRef(null);
  const [tip, setTip] = useState(null);
  const [exiting, setExiting] = useState(false);
  const [timerPaused, setTimerPaused] = useState(false);

  const clearTimer = () => {
    clearTimeout(timerRef.current.id);
    timerRef.current.id = null;
  };

  const dismiss = useCallback(() => {
    if (exitTimerRef.current) return;
    clearTimer();
    setTimerPaused(false);
    setExiting(true);
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null;
      setTip(null);
      setExiting(false);
    }, EXIT_MS);
  }, []);

  const startTimer = useCallback(
    (durationMs) => {
      clearTimer();
      timerRef.current.deadline = Date.now() + durationMs;
      timerRef.current.id = setTimeout(dismiss, durationMs);
    },
    [dismiss]
  );

  const pauseTimer = useCallback(() => {
    if (!timerRef.current.id) return;
    clearTimer();
    timerRef.current.remainingMs = timerRef.current.deadline - Date.now();
    setTimerPaused(true);
  }, []);

  const resumeTimer = useCallback(() => {
    if (timerRef.current.id || exitTimerRef.current) return;
    startTimer(Math.max(timerRef.current.remainingMs, MIN_RESUME_MS));
    setTimerPaused(false);
  }, [startTimer]);

  useEffect(() => {
    const unsubscribeHold = window.electronAPI?.onHoldDictationEnded?.(({ inputKind, heldMs }) => {
      pendingRef.current = gateRef.current.qualifies(heldMs) ? { inputKind } : null;
    });
    const unsubscribeLatch = window.electronAPI?.onHandsFreeLatched?.(() => {
      gateRef.current.markHandsFreeUsed();
      pendingRef.current = null;
      armedRef.current = null;
      dismiss();
    });
    return () => {
      unsubscribeHold?.();
      unsubscribeLatch?.();
      clearTimer();
      clearTimeout(exitTimerRef.current);
    };
  }, [dismiss]);

  // A new session supersedes a hold whose run never completed (error, cancel).
  useEffect(() => {
    if (recording) pendingRef.current = null;
  }, [recording]);

  useEffect(() => {
    if (completedRuns === seenRunsRef.current) return;
    seenRunsRef.current = completedRuns;
    armedRef.current = pendingRef.current;
    pendingRef.current = null;
  }, [completedRuns]);

  useEffect(() => {
    if (!atRest) {
      if (tip) dismiss();
      return;
    }
    if (!armedRef.current || tip) return;
    const next = armedRef.current;
    armedRef.current = null;
    gateRef.current.markShown();
    setTip(next);
    startTimer(HANDS_FREE_TIP_DURATION_MS);
  }, [atRest, tip, dismiss, startTimer]);

  return {
    tip,
    exiting,
    visible: tip !== null && !exiting,
    inputKind: tip?.inputKind ?? null,
    timerPaused,
    dismiss,
    pauseTimer,
    resumeTimer,
  };
}
