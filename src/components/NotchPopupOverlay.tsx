import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Square } from "lucide-react";

type Phase = "recording" | "processing" | "idle";

interface NotchState {
  phase: Phase;
  expanded: boolean;
  elapsedResetToken: number;
  menuBarHeight?: number;
  notchSpacerWidth?: number;
  leftWingWidth?: number;
  rightWingWidth?: number;
  panelHeight?: number;
}

// Island sizes from the Figma design, tuned on request: +5px per side,
// large shortened, minimal hugs the menu bar height.
const ISLAND = {
  minimal: { width: 330, radius: 22 },
  medium: { width: 480, height: 160, radius: 24 },
  large: { width: 525, height: 240, radius: 28 },
};
const FALLBACK_MENU_BAR_HEIGHT = 38;
// Visible room needed beside the notch: paddings (24) + dot/REC or MM:SS timer (~56).
const MINIMAL_SIDE_ROOM = 80;
// Fallbacks used before the first state push; main reports live per-display values.
const FALLBACK_NOTCH_WIDTH = 210;
const FALLBACK_PANEL_HEIGHT = ISLAND.medium.height;
// Side area narrower than this hides the REC label (dot stays), per the design's responsive intent.
const REC_LABEL_MIN_SIDE = 64;

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// Length of the longest common prefix shared by two strings.
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

export default function NotchPopupOverlay() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("recording");
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState("");
  // Post-dictation cleanup hold; only ever set while expanded.
  const [holding, setHolding] = useState(false);
  const [notchWidth, setNotchWidth] = useState(FALLBACK_NOTCH_WIDTH);
  const [menuBarHeight, setMenuBarHeight] = useState(FALLBACK_MENU_BAR_HEIGHT);
  const [panelHeight, setPanelHeight] = useState(FALLBACK_PANEL_HEIGHT);
  // Top fade only makes sense once the transcript actually overflows.
  const [overflowing, setOverflowing] = useState(false);
  const [hovered, setHovered] = useState(false);
  // Drives enter transition on first paint, exit transition on idle.
  const [entered, setEntered] = useState(false);
  const resetTokenRef = useRef<number>(-1);
  // Wall-clock start of the current elapsed count; timer reads from this, not tick accrual.
  const startRef = useRef<number>(Date.now());
  const timerRef = useRef<number | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const prevTranscriptRef = useRef<string>("");
  // Mirror of `expanded` for the once-mounted preview subscription.
  const expandedRef = useRef(false);

  const applyState = useCallback((state: NotchState | null) => {
    if (!state) return;
    setPhase(state.phase);
    setExpanded(Boolean(state.expanded));
    if (typeof state.notchSpacerWidth === "number" && state.notchSpacerWidth > 0) {
      setNotchWidth(state.notchSpacerWidth);
    }
    if (typeof state.menuBarHeight === "number" && state.menuBarHeight > 0) {
      setMenuBarHeight(state.menuBarHeight);
    }
    if (typeof state.panelHeight === "number" && state.panelHeight > 0) {
      setPanelHeight(state.panelHeight);
    }
    if (state.phase === "idle") {
      // Collapse the island back into the notch; the window closes shortly after.
      setEntered(false);
    } else {
      // Session reused within the retract window: re-play the enter transition.
      requestAnimationFrame(() => setEntered(true));
    }
    if (state.elapsedResetToken !== resetTokenRef.current) {
      resetTokenRef.current = state.elapsedResetToken;
      startRef.current = Date.now();
      setElapsed(0);
      // Fresh session in a reused window: clear everything the last session left behind.
      setTranscript("");
      setHolding(false);
      setOverflowing(false);
      setHovered(false);
      window.electronAPI?.setNotchPopupInteractivity?.(false);
    }
  }, []);

  // Receive state pushes and signal ready so main can reveal the window.
  useEffect(() => {
    const cleanup = window.electronAPI?.onNotchPopupState?.((state: NotchState) =>
      applyState(state)
    );
    window.electronAPI
      ?.getNotchPopupState?.()
      .then((pulled: NotchState | null) => applyState(pulled))
      .catch(() => {});
    window.electronAPI?.notchPopupReady?.();
    return () => cleanup?.();
  }, [applyState]);

  // Keep the ref in sync and clear any hold state if the panel collapses.
  useEffect(() => {
    expandedRef.current = expanded;
    if (!expanded) setHolding(false);
  }, [expanded]);

  // Trigger the enter transition on the first frame after mount.
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Elapsed timer runs only while recording; leaving recording freezes the last value.
  useEffect(() => {
    if (phase !== "recording") return;
    // Derive from the start timestamp so throttled/missed ticks never lose time.
    const tick = () =>
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    tick();
    timerRef.current = window.setInterval(tick, 1000);
    return () => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [phase]);

  // Live transcript from the shared preview channels (expanded mode only).
  useEffect(() => {
    const onText = window.electronAPI?.onPreviewText?.((incoming: string) => {
      setTranscript(incoming?.trim?.() || "");
    });
    const onAppend = window.electronAPI?.onPreviewAppend?.((chunk: string) => {
      const trimmed = chunk?.trim?.();
      if (!trimmed) return;
      setTranscript((prev) => (prev ? `${prev} ${trimmed}` : trimmed));
    });
    // Cleanup hold dims the transcript; skip compact popups (no panel).
    const onHold = window.electronAPI?.onPreviewHold?.(
      (payload: { showCleanup: boolean }) => {
        if (!expandedRef.current) return;
        if (payload?.showCleanup) setHolding(true);
      }
    );
    const onResult = window.electronAPI?.onPreviewResult?.((payload: { text?: string }) => {
      const next = payload?.text?.trim?.();
      // Un-dim regardless; the prefix-diff render then crossfades the final text.
      setHolding(false);
      if (next) setTranscript(next);
    });
    const onHide = window.electronAPI?.onPreviewHide?.(() => {
      setHolding(false);
      setTranscript("");
    });
    return () => {
      onText?.();
      onAppend?.();
      onHold?.();
      onResult?.();
      onHide?.();
    };
  }, []);

  // Keep newest text pinned to the bottom edge once the panel overflows.
  useEffect(() => {
    const el = textRef.current;
    if (el) {
      setOverflowing(el.scrollHeight > el.clientHeight + 1);
      el.scrollTop = el.scrollHeight;
    }
    prevTranscriptRef.current = transcript;
  }, [transcript, panelHeight, expanded, phase]);

  const handleEnter = useCallback(() => {
    setHovered(true);
    window.electronAPI?.setNotchPopupInteractivity?.(true);
  }, []);
  const handleLeave = useCallback(() => {
    setHovered(false);
    window.electronAPI?.setNotchPopupInteractivity?.(false);
  }, []);

  const handleStop = useCallback(() => {
    window.electronAPI?.notchPopupAction?.("stop");
  }, []);
  const handleOpenControlPanel = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    window.electronAPI?.notchPopupAction?.("open-control-panel");
  }, []);

  const exiting = phase === "idle";
  // Compact hugs the menu bar so it reads as part of the notch, not a tab below it.
  const minimalHeight = Math.max(menuBarHeight, FALLBACK_MENU_BAR_HEIGHT);
  const minimal = {
    ...ISLAND.minimal,
    // Wide enough that dot/REC and the full MM:SS clear the physical notch.
    width: Math.max(ISLAND.minimal.width, notchWidth + MINIMAL_SIDE_ROOM * 2),
    height: minimalHeight,
    radius: Math.min(ISLAND.minimal.radius, Math.floor(minimalHeight / 2)),
  };
  const size = !expanded
    ? minimal
    : panelHeight > ISLAND.medium.height
      ? ISLAND.large
      : ISLAND.medium;
  // Exit collapses to minimal before the fade so the island retreats toward the notch.
  const target = exiting ? minimal : size;
  const expandedVisible = expanded && !exiting;
  const compactInteractive = !expandedVisible && !exiting;
  // Hover gesture: the compact island widens slightly so the stop glyph clears the notch.
  const hoverBoost = compactInteractive && hovered ? 32 : 0;
  const recActive = phase === "recording" && !holding;
  // Room beside the physical notch inside the island's top row.
  const sideRoom = (target.width - notchWidth) / 2;

  // Prefix-diff so only the changed suffix fades; a <40% match is a full rewrite.
  const prev = prevTranscriptRef.current;
  const commonLen = commonPrefixLength(prev, transcript);
  const isRewrite = prev.length > 0 && commonLen < prev.length * 0.4;
  const stableLen = prev.length === 0 || isRewrite ? 0 : commonLen;
  const changedTail = transcript.slice(stableLen);
  // Newest ~80 chars (or the changed suffix) read bright; older text ages down.
  const brightLen = Math.max(80, changedTail.length);
  const brightStart = Math.max(0, transcript.length - brightLen);
  const dimText = transcript.slice(0, brightStart);
  const brightHead = transcript.slice(brightStart, stableLen);

  return (
    <div className={`notch-root${entered ? " is-visible" : ""}`}>
      <div
        className="notch-island"
        style={{
          width: target.width + hoverBoost,
          height: target.height,
          borderBottomLeftRadius: target.radius,
          borderBottomRightRadius: target.radius,
        }}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onContextMenu={handleOpenControlPanel}
        onClick={compactInteractive ? handleStop : undefined}
        role={compactInteractive ? "button" : undefined}
        aria-label={compactInteractive ? t("notchPopup.stopAria") : undefined}
        title={compactInteractive ? t("notchPopup.stopAria") : undefined}
      >
        {/* Top row: REC left, timer right, hardware notch between them. */}
        <div className="notch-toprow">
          <div className="notch-rec">
            <span className={`notch-dot${recActive ? " is-live" : ""}`} aria-hidden="true" />
            {sideRoom >= REC_LABEL_MIN_SIDE && (
              <span className={`notch-rec-label${recActive ? "" : " is-idle"}`}>REC</span>
            )}
            {compactInteractive && (
              <span
                className={`notch-hover-stop${hovered ? " is-shown" : ""}`}
                aria-hidden="true"
              >
                <Square size={12} />
              </span>
            )}
          </div>
          <div className="notch-time-wrap">
            <span className="notch-time">{formatElapsed(elapsed)}</span>
          </div>
        </div>

        {/* Expanded content below the hardware notch. */}
        {expandedVisible && (
          <div className="notch-body">
            <div className="notch-header">
              <span>{t("notchPopup.liveTranscript")}</span>
              <div className="notch-actions">
                <button
                  type="button"
                  className="notch-stop"
                  aria-label={t("notchPopup.stopAria")}
                  title={t("notchPopup.stopAria")}
                  onClick={handleStop}
                >
                  <Square size={14} />
                </button>
              </div>
            </div>
            <div className="notch-scroll-wrap">
              <div ref={textRef} className={`notch-scroll${overflowing ? " is-overflowing" : ""}`}>
                <p className={`notch-text${holding ? " is-holding" : ""}`}>
                  {transcript ? (
                    <>
                      {dimText && <span className="seg age-old">{dimText}</span>}
                      {brightHead && <span className="seg age-mid">{brightHead}</span>}
                      {changedTail && (
                        <span key={changedTail} className="seg age-new seg-in">
                          {changedTail}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="seg age-old">{t("notchPopup.listening")}</span>
                  )}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      <style>{`
        .notch-root {
          display: flex;
          justify-content: center;
          align-items: flex-start;
          width: 100%;
          height: 100%;
          background: transparent;
          /* spring(bounce 0.25, 600ms) from the design's motion config. */
          --spring: linear(
            0, 0.019, 0.078 2.5%, 0.283 5.7%, 0.686 10.9%, 0.917 15%, 1.008 17.7%,
            1.093 21.8%, 1.126 25.4%, 1.13 27.7%, 1.115 30.9%, 1.031 39.5%,
            0.996 44.4%, 0.98 50.7%, 0.985 60.3%, 1.001 76.1%, 1
          );
        }
        .notch-island {
          display: flex;
          flex-direction: column;
          overflow: hidden;
          position: relative;
          background: #000;
          color: #fff;
          border-top-left-radius: 0;
          border-top-right-radius: 0;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
          opacity: 0;
          will-change: width, height, opacity;
          transition:
            width 600ms var(--spring),
            height 600ms var(--spring),
            border-bottom-left-radius 600ms var(--spring),
            border-bottom-right-radius 600ms var(--spring),
            opacity 180ms ease;
        }
        .notch-root.is-visible .notch-island {
          opacity: 1;
        }
        .notch-toprow {
          display: flex;
          justify-content: space-between;
          align-items: center;
          width: 100%;
          height: 32px;
          flex-shrink: 0;
          margin-top: 4px;
          padding: 0 16px;
        }
        .notch-rec {
          display: flex;
          align-items: center;
          gap: 8px;
          height: 100%;
          padding-left: 8px;
        }
        .notch-dot {
          width: 10px;
          height: 10px;
          border-radius: 9999px;
          flex: 0 0 auto;
          background: #ef4444;
          box-shadow: 0 0 8px rgba(239, 68, 68, 0.8);
        }
        .notch-dot.is-live {
          animation: notch-pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }
        .notch-dot:not(.is-live) {
          background: #52525b;
          box-shadow: none;
        }
        @keyframes notch-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        .notch-rec-label {
          color: #ef4444;
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.05em;
          text-transform: uppercase;
        }
        .notch-rec-label.is-idle {
          opacity: 0.5;
        }
        /* Hover gesture: compact island reveals its stop affordance. */
        .notch-hover-stop {
          display: flex;
          align-items: center;
          width: 0;
          overflow: hidden;
          opacity: 0;
          color: #f87171;
          transition: width 200ms ease, opacity 200ms ease, margin-left 200ms ease;
        }
        .notch-hover-stop.is-shown {
          width: 12px;
          margin-left: 2px;
          opacity: 1;
        }
        .notch-island[role="button"] {
          cursor: pointer;
        }
        .notch-time-wrap {
          display: flex;
          align-items: center;
          gap: 12px;
          height: 100%;
          padding-right: 8px;
        }
        .notch-time {
          font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
          font-size: 14px;
          letter-spacing: 0.1em;
          color: #d4d4d8;
          /* Reserve the MM:SS footprint so crossing 10 min never shifts layout. */
          min-width: 52px;
          text-align: right;
        }
        .notch-body {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
          padding: 12px 24px 20px;
          animation: notch-body-in 300ms ease 100ms both;
        }
        @keyframes notch-body-in {
          from { opacity: 0; transform: translateY(-20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .notch-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
          padding-bottom: 8px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          color: #71717a;
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.1em;
        }
        .notch-actions {
          display: flex;
          gap: 8px;
        }
        .notch-stop {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 4px;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: #f87171;
          cursor: pointer;
          transition: background-color 150ms ease;
        }
        .notch-stop:hover {
          background: rgba(255, 255, 255, 0.08);
        }
        .notch-scroll-wrap {
          flex: 1;
          min-height: 0;
          position: relative;
          overflow: hidden;
        }
        .notch-scroll {
          height: 100%;
          overflow: hidden;
          overscroll-behavior: none;
        }
        /* Top-edge fade only once text overflows; the design's bottom fade would hide the newest live line. */
        .notch-scroll.is-overflowing {
          -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 24px);
          mask-image: linear-gradient(to bottom, transparent 0, #000 24px);
        }
        .notch-text {
          margin: 0;
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 14px;
          line-height: 1.625;
          font-weight: 500;
          color: #d4d4d8;
          white-space: pre-wrap;
          word-break: break-word;
        }
        /* Text ages: newest white, recent zinc-300, older 50%. */
        .seg { transition: color 300ms ease, opacity 300ms ease; }
        .age-old { color: #d4d4d8; opacity: 0.5; }
        .age-mid { color: #d4d4d8; opacity: 0.75; }
        .age-new { color: #ffffff; }
        .seg-in { animation: notch-seg-in 150ms ease-out; }
        @keyframes notch-seg-in {
          from { opacity: 0; }
        }
        .notch-text.is-holding .seg {
          opacity: 0.45;
          transition: opacity 200ms ease;
        }
        @media (prefers-reduced-motion: reduce) {
          .notch-island {
            transition: opacity 150ms ease !important;
          }
          .notch-dot.is-live {
            animation: none !important;
          }
          .notch-body {
            animation: none !important;
          }
          .seg, .notch-text.is-holding .seg {
            transition: none !important;
          }
          .seg-in {
            animation: none !important;
          }
          .notch-hover-stop {
            transition: none !important;
          }
        }
      `}</style>
    </div>
  );
}
