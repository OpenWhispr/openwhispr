import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { createPillVisibilityHandoff } from "../utils/pillVisibilityHandoff";
import { SIZE_RANK, resolveMainWindowSizeKey } from "../utils/windowSizeLadder";

// The pill container fades with App.jsx's `transition-opacity duration-150`;
// wait out that fade plus a couple of frames so setBounds can never catch a
// half-visible pill — change together.
const PANEL_RETURN_FADE_MS = 180;

/**
 * Single owner of the main window size: panel > menu > toast > compact pill >
 * base. Grows apply immediately so content never clips; shrinks wait for the
 * content collapse animation to finish before the window snaps down. Also owns
 * the two pill-visibility handoffs around risky native resizes: the
 * dictation-error handoff (pill hidden until the window leaves the error
 * footprint) and the panel-return handoff (pill faded out across the
 * panel-to-pill shrink).
 */
export function useMainWindowSizeOwner({
  requestMainWindowSize,
  dictationErrorActionCount,
  toastCount,
  isCommandMenuOpen,
  isCompactPill,
  assistantOpen,
  assistantMounted,
  assistantOpenRef,
  liveTranscriptOpen,
  liveTranscriptMounted,
  liveTranscriptOpenRef,
}) {
  const [handoffActive, setHandoffActive] = useState(false);
  const actionCountRef = useRef(dictationErrorActionCount);
  const handoffRef = useRef(null);
  // Same masking for the panel-return shrink: snapping the native window from
  // panel bounds back to the pill box paints one compositor frame of the old
  // texture inside the new bounds, which blanks the just-settled pill. Fade
  // the pill out, resize while nothing shows, reveal at rest.
  const [panelReturnResizeActive, setPanelReturnResizeActive] = useState(false);
  const panelReturnSuppressedRef = useRef(false);
  const panelReturnHandoffRef = useRef(null);
  useEffect(() => {
    const handoff = createPillVisibilityHandoff({
      onSuppressedChange: setHandoffActive,
      shouldAutoHide: () => useSettingsStore.getState().floatingIconAutoHide,
      hideWindow: () => window.electronAPI?.hideWindow?.(),
    });
    handoffRef.current = handoff;
    if (actionCountRef.current > 0) handoff.suppress();
    const panelReturnHandoff = createPillVisibilityHandoff({
      onSuppressedChange: (suppressed) => {
        panelReturnSuppressedRef.current = suppressed;
        setPanelReturnResizeActive(suppressed);
      },
    });
    panelReturnHandoffRef.current = panelReturnHandoff;
    return () => {
      handoff.dispose();
      panelReturnHandoff.dispose();
      if (handoffRef.current === handoff) handoffRef.current = null;
      if (panelReturnHandoffRef.current === panelReturnHandoff) {
        panelReturnHandoffRef.current = null;
      }
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
      if (panelReturnSuppressedRef.current) {
        // A panel reopened during the masked shrink; the pill re-docks inside
        // it and must not stay hidden.
        void panelReturnHandoffRef.current?.releaseAfter(async () => {});
      }
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
    if (returningFromPanel) {
      // The panel exit leaves the native window at panel bounds. Suppress the
      // pill through its opacity fade, resize while nothing is visible, and
      // reveal once bounds settle — the dictation-error handoff above exists
      // for the same artifact. No cleanup: the chase below follows the size
      // owner's latest target across effect re-runs.
      const panelReturnHandoff = panelReturnHandoffRef.current;
      if (!panelReturnHandoff) {
        void requestMainWindowSize(target);
        return undefined;
      }
      panelReturnHandoff.suppress();
      void (async () => {
        await new Promise((resolve) => setTimeout(resolve, PANEL_RETURN_FADE_MS));
        // A panel reopening during the fade re-takes the window; leave its
        // bounds alone and let the ownership branch reveal the pill.
        if (panelSizeReservationRef.current) return;
        await panelReturnHandoff.releaseAfter(async () => {
          // A menu/toast edge can supersede the target while the fade runs.
          // Follow the size owner's latest target before revealing.
          let settledTarget = lastSizeKeyRef.current;
          await requestMainWindowSize(settledTarget);
          while (lastSizeKeyRef.current !== settledTarget) {
            settledTarget = lastSizeKeyRef.current;
            await requestMainWindowSize(settledTarget);
          }
        });
      })();
      return undefined;
    }
    if (!prev || SIZE_RANK[target] >= SIZE_RANK[prev]) {
      void requestMainWindowSize(target);
      return undefined;
    }
    const timeout = setTimeout(() => void requestMainWindowSize(target), 340);
    return () => clearTimeout(timeout);
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
    dictationErrorActionCount,
    requestMainWindowSize,
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

  return { dictationErrorPillHandoffActive: handoffActive, panelReturnResizeActive };
}
