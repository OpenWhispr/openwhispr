import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { createDictationErrorPillHandoff } from "../utils/dictationErrorPillHandoff";
import { SIZE_RANK, resolveMainWindowSizeKey } from "../utils/windowSizeLadder";

/**
 * Single owner of the main window size: panel > menu > toast > compact pill >
 * base. Grows apply immediately so content never clips; shrinks wait for the
 * content collapse animation to finish before the window snaps down. Also owns
 * the dictation-error pill handoff, which hides the pill until the native
 * window has left the error footprint.
 *
 * `waitForShrink(target, prev)` is required: it decides, per shrink, what (if
 * anything) is worth waiting for — the caller knows which of its own elements
 * actually animate for a given target/prev pair, this hook does not. Return
 * an already-resolved promise for a shrink with nothing to wait on.
 */
export function useMainWindowSizeOwner({
  requestMainWindowSize,
  dictationErrorActionCount,
  toastCount,
  isCommandMenuOpen,
  isCompactPill,
  handsFreeTipVisible,
  assistantOpen,
  assistantMounted,
  assistantOpenRef,
  liveTranscriptOpen,
  liveTranscriptMounted,
  liveTranscriptOpenRef,
  waitForShrink,
}) {
  const [handoffActive, setHandoffActive] = useState(false);
  const actionCountRef = useRef(dictationErrorActionCount);
  const handoffRef = useRef(null);
  useEffect(() => {
    const handoff = createDictationErrorPillHandoff({
      onSuppressedChange: setHandoffActive,
      shouldAutoHide: () => useSettingsStore.getState().floatingIconAutoHide,
      // A RAW hide, deliberately not routed through usePillExitChoreography's
      // zoop funnel (Finding 4, final review 2026-09-08 — App.jsx's comment on
      // that funnel names this exception and why it is safe). The handoff only
      // reaches this while it still has the pill suppressed at opacity 0, so
      // there is no visible pill for a zoop to play on and no hard cut to
      // avoid. hide-window REJECTS when the main process refuses; releaseAfter
      // awaits this inside its own try/catch, so the rejection is contained —
      // see that catch's own comment for what it does and does not promise.
      hideWindow: () => window.electronAPI?.hideWindow?.(),
    });
    handoffRef.current = handoff;
    if (actionCountRef.current > 0) handoff.suppress();
    return () => {
      handoff.dispose();
      if (handoffRef.current === handoff) handoffRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    actionCountRef.current = dictationErrorActionCount;
    if (dictationErrorActionCount > 0) {
      handoffRef.current?.suppress();
    }
  }, [dictationErrorActionCount]);

  const lastSizeKeyRef = useRef(null);
  const panelSizeReservationRef = useRef(false);
  useEffect(() => {
    const panelOwnsWindow =
      assistantOpenRef.current ||
      liveTranscriptOpenRef.current ||
      assistantMounted ||
      liveTranscriptMounted;
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
      handsFreeTipVisible,
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
      void handoffRef.current?.releaseAfter(async () => {
        let settledTarget = target;
        await requestMainWindowSize(settledTarget);
        // A menu/toast edge can supersede BASE while its native resize is
        // queued. Follow the size owner's latest target before revealing.
        while (actionCountRef.current === 0 && lastSizeKeyRef.current !== settledTarget) {
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
    // A lower-ranked target means content is collapsing: let the collapse
    // finish (the caller reports its transitionend, or resolves at once when
    // there is nothing to wait for — e.g. reduced motion, or a shrink the
    // caller's own element isn't part of) before the native window snaps
    // down, so the two never animate the same edge at once. `target`/`prev`
    // let the caller tell those cases apart. A wait that rejects must still
    // let the window catch up rather than sticking at the wrong size.
    let cancelled = false;
    void waitForShrink(target, prev)
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) void requestMainWindowSize(target);
      });
    return () => {
      cancelled = true;
    };
  }, [
    assistantOpen,
    assistantMounted,
    assistantOpenRef,
    liveTranscriptOpen,
    liveTranscriptMounted,
    liveTranscriptOpenRef,
    isCommandMenuOpen,
    toastCount,
    isCompactPill,
    handsFreeTipVisible,
    dictationErrorActionCount,
    requestMainWindowSize,
    waitForShrink,
  ]);

  useEffect(() => {
    if (
      dictationErrorActionCount > 0 ||
      !handoffActive ||
      (!assistantMounted && !liveTranscriptMounted)
    ) {
      return;
    }

    // A panel already owns stable native bounds, so an error displayed inside
    // it has no compact resize to await. Release only the visual suppression.
    void handoffRef.current?.releaseAfter(async () => {});
  }, [assistantMounted, dictationErrorActionCount, handoffActive, liveTranscriptMounted]);

  return { dictationErrorPillHandoffActive: handoffActive };
}
