import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ExpandingPanelShell } from "./ExpandingPanelShell";
import { splitTranscriptForShimmer } from "../../utils/liveTranscriptPresentation";

export type LiveTranscriptPhase = "listening" | "live" | "cleanup" | "final";

interface LiveTranscriptPanelProps {
  open: boolean;
  text: string;
  phase: LiveTranscriptPhase;
  processing: boolean;
  onCollapse: () => void;
  onPreferredHeightChange: (height: number) => void;
}

const COPIED_RESET_MS = 1600;
const PIN_THRESHOLD_PX = 40;

export function LiveTranscriptPanel({
  open,
  text,
  phase,
  processing,
  onCollapse,
  onPreferredHeightChange,
}: LiveTranscriptPanelProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedToBottomRef = useRef(true);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);
  const shouldShimmer = Boolean(text) && (phase === "live" || phase === "cleanup" || processing);
  const shimmerParts = useMemo(
    () => (shouldShimmer ? splitTranscriptForShimmer(text) : { settled: text, active: "" }),
    [shouldShimmer, text]
  );

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (!text) {
      pinnedToBottomRef.current = true;
      node.scrollTop = 0;
      return;
    }
    if (pinnedToBottomRef.current) node.scrollTop = node.scrollHeight;
  }, [text]);

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    pinnedToBottomRef.current =
      node.scrollHeight - node.scrollTop - node.clientHeight < PIN_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    setCopied(false);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, [text]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    []
  );

  const handleCopy = useCallback(async () => {
    const textToCopy = text.trim();
    if (!textToCopy) return;

    try {
      const result = await window.electronAPI?.writeClipboard?.(textToCopy);
      if (result?.success === false) throw new Error("clipboard-write-failed");
    } catch {
      try {
        await navigator.clipboard.writeText(textToCopy);
      } catch {
        return;
      }
    }

    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }, [text]);

  return (
    <ExpandingPanelShell
      open={open}
      anchor="bottom-left"
      className="live-transcript-panel"
      aria-label={t("transcriptionPreview.label")}
      aria-busy={shouldShimmer}
      stabilizeHeight={shouldShimmer}
      onPreferredHeightChange={onPreferredHeightChange}
    >
      <main
        ref={scrollRef}
        onScroll={handleScroll}
        data-panel-scroll-region
        className="agent-chat-scroll min-h-0 flex-auto overflow-y-auto overscroll-contain px-5 pb-3 pt-8"
        aria-live="polite"
        aria-atomic="true"
      >
        {text ? (
          <p className="select-text whitespace-pre-wrap break-words text-base leading-relaxed text-foreground [text-wrap:pretty]">
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
      </main>

      <footer className="flex h-16 shrink-0 items-center justify-end gap-3 px-5">
        <button
          type="button"
          onClick={() => void handleCopy()}
          disabled={!text.trim()}
          className="inline-flex size-10 items-center justify-center rounded-full border border-border/35 bg-surface-1 text-muted-foreground shadow-[var(--shadow-card)] transition-colors hover:border-border/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
          aria-label={copied ? t("transcriptionPreview.copied") : t("transcriptionPreview.copy")}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </button>
        <button
          type="button"
          onClick={onCollapse}
          className="inline-flex size-10 items-center justify-center rounded-full border border-border/35 bg-surface-1 text-foreground shadow-[var(--shadow-card)] transition-colors hover:border-border/60 hover:bg-surface-2"
          aria-label={t("transcriptionPreview.collapse", { defaultValue: "Collapse transcript" })}
        >
          <ChevronDown className="size-5" />
        </button>
      </footer>
    </ExpandingPanelShell>
  );
}
