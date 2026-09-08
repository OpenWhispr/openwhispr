import { useCallback, useEffect, useRef, useState } from "react";
import { MOTION_TIMING } from "../utils/springEasing";
import { settleFallbackMs, waitForTransitionEnd } from "../utils/transitionSettled";
import { shouldAwaitPillZoop } from "../helpers/voicePillPresentation";

const prefersReducedMotion = () =>
  Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

/**
 * The pill leaves with a "zoop" (scale into its own centre) and the native
 * window hides after; on the next show it springs back. `exiting` stays set
 * while hidden so the first visible frame starts from the exited pose and the
 * unzoop has somewhere to come from. Main-initiated hides arrive as
 * pill-will-hide and run the same sequence.
 *
 * Anything that keeps the window on screen — a show, the window becoming
 * visible again, a recording starting — ABORTS an exit in flight rather than
 * only clearing the pose. Clearing the pose alone is not enough: dropping
 * `data-pill-exit` replaces the running transform transition, which fires
 * `transitioncancel`, and waitForTransitionEnd settles on that — so a hide
 * that only watched the pose would go on to hide the window the user has just
 * asked for. (Task 7's review found this same stranding shape on the
 * companion pill.)
 */
export function usePillExitChoreography({ pillPresenceRef, recording }) {
  const [exiting, setExiting] = useState(false);
  // The pose is also read inside hideWithZoop, which must see the CURRENT
  // value rather than the one captured when the callback was created.
  const exitedRef = useRef(false);
  const inFlightRef = useRef(null);

  const setExitPose = useCallback((next) => {
    exitedRef.current = next;
    setExiting(next);
  }, []);

  const cancelExit = useCallback(() => {
    const run = inFlightRef.current;
    if (run) {
      run.cancelled = true;
      // Dropped here rather than in the run's own cleanup so an immediately
      // following hide starts a fresh exit instead of adopting this
      // cancelled one and never hiding at all.
      inFlightRef.current = null;
    }
    setExitPose(false);
  }, [setExitPose]);

  const hideWithZoop = useCallback(() => {
    if (inFlightRef.current) return inFlightRef.current.promise;
    const run = { cancelled: false, promise: null };
    const awaitZoop = shouldAwaitPillZoop({
      prefersReducedMotion: prefersReducedMotion(),
      alreadyExited: exitedRef.current,
    });
    setExitPose(true);
    run.promise = (async () => {
      if (awaitZoop) {
        await waitForTransitionEnd(
          pillPresenceRef.current,
          "transform",
          settleFallbackMs(MOTION_TIMING.zoopMs)
        );
      }
      if (run.cancelled) return { hidden: false, cancelled: true };
      try {
        await window.electronAPI?.hideWindow?.();
        return { hidden: true, cancelled: false };
      } catch {
        // The window is staying up: either main refused the hide (the
        // Assistant panel owns the window) or the handler is not registered
        // yet. Either way the pill must come back rather than sit collapsed
        // and invisible on a window nothing will hide.
        setExitPose(false);
        return { hidden: false, cancelled: false };
      }
    })().finally(() => {
      if (inFlightRef.current === run) inFlightRef.current = null;
    });
    inFlightRef.current = run;
    return run.promise;
  }, [pillPresenceRef, setExitPose]);

  useEffect(() => {
    const unsubscribeHide = window.electronAPI?.onPillWillHide?.(() => {
      void hideWithZoop();
    });
    const unsubscribeShow = window.electronAPI?.onPillWillShow?.(() => cancelExit());
    const onVisibility = () => {
      if (document.visibilityState === "visible") cancelExit();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unsubscribeHide?.();
      unsubscribeShow?.();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [hideWithZoop, cancelExit]);

  useEffect(() => {
    if (recording) cancelExit();
  }, [recording, cancelExit]);

  return { exiting, hideWithZoop };
}
