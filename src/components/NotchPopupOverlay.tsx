import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type Phase = "recording" | "processing" | "idle";

interface NotchState {
  phase: Phase;
  expanded: boolean;
  elapsedResetToken: number;
  menuBarHeight?: number;
  notchSpacerWidth?: number;
  leftWingWidth?: number;
  rightWingWidth?: number;
}

// Fallback strip height when the main process cannot report the menu bar inset.
const FALLBACK_MENU_BAR_HEIGHT = 38;
// Fallbacks used before the first state push; main reports live per-display values.
const FALLBACK_NOTCH_SPACER_WIDTH = 210;
const FALLBACK_LEFT_WING_WIDTH = 68;
const FALLBACK_RIGHT_WING_WIDTH = 48;

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
  const [menuBarHeight, setMenuBarHeight] = useState(0);
  const [notchSpacerWidth, setNotchSpacerWidth] = useState(FALLBACK_NOTCH_SPACER_WIDTH);
  const [leftWingWidth, setLeftWingWidth] = useState(FALLBACK_LEFT_WING_WIDTH);
  const [rightWingWidth, setRightWingWidth] = useState(FALLBACK_RIGHT_WING_WIDTH);
  // Drives enter transition on first paint, exit transition on idle.
  const [entered, setEntered] = useState(false);
  const resetTokenRef = useRef<number>(-1);
  const timerRef = useRef<number | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const prevTranscriptRef = useRef<string>("");
  // Mirror of `expanded` for the once-mounted preview subscription.
  const expandedRef = useRef(false);

  const applyState = useCallback((state: NotchState | null) => {
    if (!state) return;
    setPhase(state.phase);
    setExpanded(Boolean(state.expanded));
    if (typeof state.menuBarHeight === "number" && state.menuBarHeight > 0) {
      setMenuBarHeight(state.menuBarHeight);
    }
    if (typeof state.notchSpacerWidth === "number" && state.notchSpacerWidth > 0) {
      setNotchSpacerWidth(state.notchSpacerWidth);
    }
    if (typeof state.leftWingWidth === "number" && state.leftWingWidth > 0) {
      setLeftWingWidth(state.leftWingWidth);
    }
    if (typeof state.rightWingWidth === "number" && state.rightWingWidth > 0) {
      setRightWingWidth(state.rightWingWidth);
    }
    if (state.phase === "idle") {
      // Retract the wings back under the notch; the window closes shortly after.
      setEntered(false);
    }
    if (state.elapsedResetToken !== resetTokenRef.current) {
      resetTokenRef.current = state.elapsedResetToken;
      setElapsed(0);
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

  // Elapsed timer runs only while recording.
  useEffect(() => {
    if (phase === "recording") {
      timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    } else if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
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

  // Keep newest text pinned to the bottom edge, teleprompter style.
  useEffect(() => {
    const el = textRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    prevTranscriptRef.current = transcript;
  }, [transcript]);

  const handleEnter = useCallback(() => {
    window.electronAPI?.setNotchPopupInteractivity?.(true);
  }, []);
  const handleLeave = useCallback(() => {
    window.electronAPI?.setNotchPopupInteractivity?.(false);
  }, []);

  const handleStop = useCallback(() => {
    window.electronAPI?.notchPopupAction?.("stop");
  }, []);
  const handleOpenControlPanel = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    window.electronAPI?.notchPopupAction?.("open-control-panel");
  }, []);

  const stripHeight = menuBarHeight > 0 ? menuBarHeight : FALLBACK_MENU_BAR_HEIGHT;
  const exiting = phase === "idle";
  const dotClass =
    phase === "processing" || holding ? "notch-dot processing" : "notch-dot recording";

  // Prefix-diff so only the changed suffix fades; a <40% match is a full rewrite.
  const prev = prevTranscriptRef.current;
  const commonLen = commonPrefixLength(prev, transcript);
  const isRewrite = prev.length > 0 && commonLen < prev.length * 0.4;
  const stableLen = prev.length === 0 || isRewrite ? 0 : commonLen;
  const changedTail = transcript.slice(stableLen);
  // Newest ~80 chars (or the changed suffix) read bright; older text dims.
  const brightLen = Math.max(80, changedTail.length);
  const brightStart = Math.max(0, transcript.length - brightLen);
  const dimText = transcript.slice(0, brightStart);
  const brightHead = transcript.slice(brightStart, stableLen);

  return (
    <div
      className={`notch-root${entered ? " is-visible" : ""}${expanded ? " is-expanded" : ""}`}
      style={{ ["--notch-dur" as string]: exiting ? "180ms" : "240ms" }}
    >
      {/* Wings row: sized to exactly the menu bar height so it sits inline with the notch. */}
      <div className="notch-strip" style={{ height: stripHeight }}>
        {/* Left wing: recording dot + elapsed timer. Hugs the notch. */}
        <div
          className="notch-wing left"
          style={{ width: leftWingWidth, height: stripHeight }}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
        >
          <span className={dotClass} aria-hidden="true" />
          <span className="notch-timer">{formatElapsed(elapsed)}</span>
        </div>

        {/* Center spacer: click-through, renders nothing so the physical notch shows. */}
        <div
          className="notch-spacer"
          style={{ width: notchSpacerWidth, height: stripHeight }}
          aria-hidden="true"
        />

        {/* Right wing: mic button. Click stops, right-click opens Control Panel. */}
        <div
          className="notch-wing right"
          style={{ width: rightWingWidth, height: stripHeight }}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
        >
          <button
            type="button"
            aria-label={t("notchPopup.stopAria")}
            title={t("notchPopup.openControlPanelAria")}
            onClick={handleStop}
            onContextMenu={handleOpenControlPanel}
            className="notch-mic"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="2" width="6" height="11" rx="3" />
              <path d="M5 10a7 7 0 0 0 14 0" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          </button>
        </div>
      </div>

      {/* Expanded transcript panel, attached directly below the strip. */}
      {expanded && (
        <div
          className="notch-panel"
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
        >
          {/* Inner wrapper carries the entrance translateY so the panel stays flush. */}
          <div ref={textRef} className="notch-transcript">
            <p className={`notch-transcript-text${holding ? " is-holding" : ""}`}>
              {transcript ? (
                <>
                  {dimText && (
                    <span key="dim" className="notch-seg notch-dim">
                      {dimText}
                    </span>
                  )}
                  {brightHead && (
                    <span key="bright" className="notch-seg notch-bright">
                      {brightHead}
                    </span>
                  )}
                  {changedTail && (
                    <span
                      key={changedTail}
                      className="notch-seg notch-bright notch-fade-in"
                    >
                      {changedTail}
                    </span>
                  )}
                </>
              ) : (
                <span className="notch-seg notch-dim">
                  {t("notchPopup.listening")}
                </span>
              )}
            </p>
          </div>
        </div>
      )}

      <style>{`
        .notch-root {
          display: flex;
          flex-direction: column;
          align-items: center;
          width: 100%;
          height: 100%;
          background: transparent;
        }
        .notch-strip {
          display: flex;
          width: 100%;
          align-items: stretch;
          justify-content: center;
        }
        .notch-wing {
          display: flex;
          flex: 0 0 auto;
          align-items: center;
          gap: 6px;
          background: #000;
          opacity: 0;
          will-change: transform, opacity;
          transition:
            transform var(--notch-dur) cubic-bezier(0.23, 1, 0.32, 1),
            opacity var(--notch-dur) cubic-bezier(0.23, 1, 0.32, 1),
            border-radius 180ms ease;
        }
        /* overflow visible so a 10+ min timer spills toward the notch, not clipped. */
        .notch-wing.left {
          justify-content: flex-end;
          padding-left: 10px;
          padding-right: 8px;
          border-bottom-left-radius: 12px;
          /* Inner corner; flattened in expanded mode. */
          border-bottom-right-radius: 8px;
          transform: translateX(24px);
          overflow: visible;
        }
        .notch-wing.right {
          justify-content: flex-start;
          padding-left: 8px;
          padding-right: 10px;
          border-bottom-right-radius: 12px;
          /* Inner corner (adjacent to the notch spacer). */
          border-bottom-left-radius: 8px;
          transform: translateX(-24px);
        }
        .notch-root.is-visible .notch-wing {
          opacity: 1;
          transform: translateX(0);
        }
        /* Expanded: wings drop all bottom radii so the panel is the only rounding. */
        .notch-root.is-expanded .notch-wing.left,
        .notch-root.is-expanded .notch-wing.right {
          border-bottom-left-radius: 0;
          border-bottom-right-radius: 0;
        }
        .notch-spacer {
          flex: 0 0 auto;
          pointer-events: none;
          background: transparent;
        }
        .notch-timer {
          font-family: system-ui, -apple-system, sans-serif;
          /* 12.5px reads tighter than 13px against the dot at menu-bar height. */
          font-size: 12.5px;
          font-weight: 500;
          line-height: 1;
          font-variant-numeric: tabular-nums;
          letter-spacing: 0.02em;
          color: rgba(255, 255, 255, 0.92);
          /* Reserve the MM:SS footprint so crossing 10 min never shifts the dot. */
          min-width: 34px;
          text-align: right;
        }
        .notch-dot {
          width: 6px;
          height: 6px;
          border-radius: 9999px;
          flex: 0 0 auto;
        }
        .notch-dot.recording {
          background: #ff453a;
          animation: notch-dot-pulse 2s ease-in-out infinite;
        }
        .notch-dot.processing {
          background: rgba(255, 255, 255, 0.4);
        }
        @keyframes notch-dot-pulse {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
        .notch-mic {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          border: none;
          border-radius: 9999px;
          background: transparent;
          color: #fff;
          cursor: pointer;
          transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1),
            background-color 150ms ease;
        }
        .notch-mic svg {
          opacity: 0.85;
          transition: opacity 150ms ease;
        }
        @media (hover: hover) and (pointer: fine) {
          .notch-mic:hover {
            background: rgba(255, 255, 255, 0.12);
          }
          .notch-mic:hover svg {
            opacity: 1;
          }
        }
        .notch-mic:active {
          transform: scale(0.97);
        }
        .notch-panel {
          width: 100%;
          height: 240px;
          background: #000;
          border-bottom-left-radius: 16px;
          border-bottom-right-radius: 16px;
          /* Overlap the strip by 0.5px so no seam opens between strip and panel. */
          margin-top: -0.5px;
          padding: 12.5px 16px 14px;
          opacity: 0;
          will-change: opacity;
          /* Opacity only so the backdrop stays flush against the strip. */
          transition: opacity 200ms ease-out;
        }
        .notch-root.is-visible .notch-panel {
          opacity: 1;
          transition-delay: 60ms;
        }
        .notch-transcript {
          display: flex;
          flex-direction: column;
          justify-content: flex-end;
          height: 100%;
          overflow: hidden;
          /* The entrance translateY lives on the content, not the black panel. */
          transform: translateY(6px);
          will-change: transform;
          transition: transform 200ms ease-out;
          -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 28px);
          mask-image: linear-gradient(to bottom, transparent 0, #000 28px);
        }
        .notch-root.is-visible .notch-transcript {
          transform: translateY(0);
          transition-delay: 60ms;
        }
        .notch-transcript-text {
          margin: 0;
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 13px;
          line-height: 1.5;
          color: rgba(255, 255, 255, 0.92);
          white-space: pre-wrap;
          word-break: break-word;
        }
        /* Teleprompter depth: text ages from bright to dim over 300ms. */
        .notch-seg {
          transition: color 300ms ease;
        }
        .notch-dim {
          color: rgba(255, 255, 255, 0.55);
        }
        .notch-bright {
          color: rgba(255, 255, 255, 0.95);
        }
        .notch-fade-in {
          animation: notch-fade-in 150ms ease-out;
        }
        /* Higher specificity so every segment dims together during the hold. */
        .notch-transcript-text.is-holding .notch-seg {
          color: rgba(255, 255, 255, 0.45);
          transition: color 200ms ease;
        }
        @keyframes notch-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .notch-wing,
          .notch-root.is-visible .notch-wing,
          .notch-panel,
          .notch-root.is-visible .notch-panel,
          .notch-transcript,
          .notch-root.is-visible .notch-transcript {
            transform: none !important;
            /* Opacity-only fade; the radius change (wings) applies instantly. */
            transition: opacity 150ms ease !important;
            transition-delay: 0ms !important;
          }
          .notch-dot.recording {
            animation: none !important;
            opacity: 1;
          }
          /* Item 1 and 2 degrade to instant text updates: no fade, no aging. */
          .notch-fade-in {
            animation: none !important;
          }
          .notch-seg,
          .notch-transcript-text.is-holding .notch-seg {
            transition: none !important;
          }
        }
      `}</style>
    </div>
  );
}
