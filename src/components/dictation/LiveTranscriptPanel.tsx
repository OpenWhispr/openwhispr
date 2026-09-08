import { useMemo } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { useStickToBottom } from "../../hooks/useStickToBottom";
import { splitTranscriptForShimmer } from "../../utils/liveTranscriptPresentation";

export type LiveTranscriptPhase = "listening" | "live" | "cleanup" | "final";

interface LiveTranscriptPanelProps {
  text: string;
  measurementText: string;
  phase: LiveTranscriptPhase;
  processing: boolean;
  controlsVisible: boolean;
  contentVisible: boolean;
  onCollapse: () => void;
  onHoldChange?: (held: boolean) => void;
}

const COPIED_RESET_MS = 1600;

export function LiveTranscriptPanel({
  text,
  measurementText,
  phase,
  processing,
  controlsVisible,
  contentVisible,
  onCollapse,
  onHoldChange,
}: LiveTranscriptPanelProps) {
  const { t } = useTranslation();
  const {
    scrollRef,
    handleScroll,
    handleWheel,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  } = useStickToBottom<HTMLDivElement>(text, { resetToTop: !text });
  const { copied, copy: handleCopy } = useCopyFeedback(text, { resetMs: COPIED_RESET_MS });
  const shouldShimmer = Boolean(text) && (phase === "live" || phase === "cleanup" || processing);
  const shimmerParts = useMemo(
    () => (shouldShimmer ? splitTranscriptForShimmer(text) : { settled: text, active: "" }),
    [shouldShimmer, text]
  );

  return (
    <>
      <main
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onMouseEnter={() => onHoldChange?.(true)}
        onMouseLeave={() => onHoldChange?.(false)}
        data-panel-scroll-region
        className={`agent-chat-scroll min-h-0 flex-auto overflow-y-auto overscroll-contain px-5 pb-3 pt-8 transition-[opacity,transform] duration-200 ease-out ${
          contentVisible
            ? "translate-y-0 opacity-100 delay-75"
            : "pointer-events-none translate-y-2 opacity-0 delay-0"
        }`}
        aria-label={t("transcriptionPreview.label")}
        aria-busy={shouldShimmer}
        aria-hidden={!contentVisible}
        aria-live="polite"
      >
        <div>
          {text ? (
            <p className="select-text whitespace-pre-wrap break-words text-base leading-relaxed text-foreground">
              <span>{shimmerParts.settled}</span>
              {shimmerParts.active && (
                <span className="inline-response-shimmer">{shimmerParts.active}</span>
              )}
            </p>
          ) : (
            <p className="text-base leading-relaxed text-muted-foreground/55">
              {t("transcriptionPreview.waitingForInput")}
            </p>
          )}
        </div>
      </main>

      <footer
        className="flex h-16 shrink-0 items-center justify-end px-4"
        onMouseEnter={() => onHoldChange?.(true)}
        onMouseLeave={() => onHoldChange?.(false)}
      >
        <div
          className={`flex items-center gap-2 transition-[opacity,transform] duration-200 ease-out ${
            controlsVisible
              ? "translate-x-0 opacity-100"
              : "pointer-events-none translate-x-2 opacity-0"
          }`}
          aria-hidden={!controlsVisible}
        >
          <button
            type="button"
            onClick={() => void handleCopy()}
            disabled={!controlsVisible || !text.trim()}
            tabIndex={controlsVisible ? 0 : -1}
            className="inline-flex size-9 items-center justify-center rounded-full border border-border/35 bg-surface-1 text-muted-foreground shadow-[var(--shadow-card)] transition-colors hover:border-border/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
            aria-label={copied ? t("transcriptionPreview.copied") : t("transcriptionPreview.copy")}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </button>
          <button
            type="button"
            onClick={onCollapse}
            disabled={!controlsVisible}
            tabIndex={controlsVisible ? 0 : -1}
            className="inline-flex size-9 items-center justify-center rounded-full border border-border/35 bg-surface-1 text-foreground shadow-[var(--shadow-card)] transition-colors hover:border-border/60 hover:bg-surface-2 disabled:pointer-events-none"
            aria-label={t("transcriptionPreview.collapse", { defaultValue: "Collapse transcript" })}
          >
            <ChevronDown className="size-4" />
          </button>
        </div>
      </footer>

      <div
        data-panel-size-source
        className="pointer-events-none absolute inset-x-5 top-0 invisible pb-3 pt-8"
        aria-hidden="true"
      >
        <p className="whitespace-pre-wrap break-words text-base leading-relaxed">
          {measurementText || t("transcriptionPreview.waitingForInput")}
        </p>
      </div>
    </>
  );
}
