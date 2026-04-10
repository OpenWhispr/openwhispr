import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { useTranslation } from "react-i18next";

type PreviewPhase = "listening" | "live" | "cleanup" | "final";

const FINAL_HIDE_DURATION_MS = 4000;
const COPIED_RESET_MS = 1400;
const HIDE_ANIMATION_MS = 220;
const TARGET_WIDTH = 420;

export default function TranscriptionPreviewOverlay() {
  const { t } = useTranslation();
  const [rawText, setRawText] = useState("");
  const [finalText, setFinalText] = useState("");
  const [phase, setPhase] = useState<PreviewPhase>("listening");
  const [isVisible, setIsVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [countdownKey, setCountdownKey] = useState(0);

  const shellRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const phaseRef = useRef<PreviewPhase>("listening");
  const rawTextRef = useRef("");
  const hideTimerRef = useRef<number | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    rawTextRef.current = rawText;
  }, [rawText]);

  const clearTimer = (timerRef: { current: number | null }) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const clearLifecycleTimers = useCallback(() => {
    clearTimer(hideTimerRef);
    clearTimer(resetTimerRef);
  }, []);

  const resetCopyState = useCallback(() => {
    clearTimer(copiedTimerRef);
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }, []);

  const startHideTimer = useCallback((delayMs: number) => {
    clearTimer(hideTimerRef);
    hideTimerRef.current = window.setTimeout(() => {
      window.electronAPI?.hideDictationPreview?.();
    }, delayMs);
  }, []);

  const activeText = phase === "final" ? finalText || rawText : rawText;

  useEffect(() => {
    if (phase === "final") {
      setCountdownKey((k) => k + 1);
    }
  }, [phase]);

  const showFinalResult = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        window.electronAPI?.hideDictationPreview?.();
        return;
      }

      clearLifecycleTimers();
      setFinalText(trimmed);
      setPhase("final");
      setCopied(false);
      setIsVisible(true);
      startHideTimer(FINAL_HIDE_DURATION_MS);
    },
    [clearLifecycleTimers, startHideTimer]
  );

  const requestResize = useCallback(() => {
    if (!isVisible || !shellRef.current || !window.electronAPI?.resizeTranscriptionPreviewWindow) {
      return;
    }

    const nextHeight = Math.ceil(shellRef.current.getBoundingClientRect().height) + 16;
    window.electronAPI.resizeTranscriptionPreviewWindow(TARGET_WIDTH, nextHeight).catch(() => {});
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible || !shellRef.current) return;

    const node = shellRef.current;
    const frameId = window.requestAnimationFrame(() => requestResize());
    const observer = new ResizeObserver(() => requestResize());
    observer.observe(node);

    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [isVisible, requestResize]);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      setHasOverflow(el.scrollHeight > el.clientHeight + 2);
    });
  }, [rawText, finalText, phase]);

  useEffect(() => {
    const handlePreviewText = window.electronAPI?.onPreviewText?.((incoming: string) => {
      clearLifecycleTimers();
      clearTimer(copiedTimerRef);
      setRawText(incoming?.trim?.() || "");
      setFinalText("");
      setCopied(false);
      setHasOverflow(false);
      setPhase(incoming?.trim?.() ? "live" : "listening");
      setIsVisible(true);
    });

    const handlePreviewAppend = window.electronAPI?.onPreviewAppend?.((chunk: string) => {
      const trimmedChunk = chunk?.trim?.();
      if (!trimmedChunk) return;

      setRawText((prev) => (prev ? `${prev} ${trimmedChunk}` : trimmedChunk));
      if (phaseRef.current !== "cleanup" && phaseRef.current !== "final") {
        setPhase("live");
      }
      setIsVisible(true);
    });

    const handlePreviewHold = window.electronAPI?.onPreviewHold?.((payload) => {
      clearTimer(hideTimerRef);
      setCopied(false);

      if (phaseRef.current === "final") return;

      if (payload?.showCleanup) {
        setPhase("cleanup");
      } else {
        showFinalResult(rawTextRef.current);
      }
    });

    const handlePreviewResult = window.electronAPI?.onPreviewResult?.((payload) => {
      const nextText = payload?.text?.trim?.();
      if (!nextText) {
        window.electronAPI?.hideDictationPreview?.();
        return;
      }

      showFinalResult(nextText);
    });

    const handlePreviewHide = window.electronAPI?.onPreviewHide?.(() => {
      clearLifecycleTimers();
      clearTimer(copiedTimerRef);
      setIsVisible(false);

      clearTimer(resetTimerRef);
      resetTimerRef.current = window.setTimeout(() => {
        setRawText("");
        setFinalText("");
        setCopied(false);
        setHasOverflow(false);
        setPhase("listening");
      }, HIDE_ANIMATION_MS);
    });

    return () => {
      clearLifecycleTimers();
      clearTimer(copiedTimerRef);
      handlePreviewText?.();
      handlePreviewAppend?.();
      handlePreviewHold?.();
      handlePreviewResult?.();
      handlePreviewHide?.();
    };
  }, [clearLifecycleTimers, showFinalResult]);

  const handleCopy = useCallback(async () => {
    const textToCopy = activeText.trim();
    if (!textToCopy) return;

    try {
      const result = await window.electronAPI?.writeClipboard?.(textToCopy);
      if (result?.success === false) throw new Error("clipboard-write-failed");
      setCopied(true);
      resetCopyState();
      if (phaseRef.current === "final") {
        startHideTimer(FINAL_HIDE_DURATION_MS);
        setCountdownKey((k) => k + 1);
      }
    } catch {
      try {
        await navigator.clipboard.writeText(textToCopy);
        setCopied(true);
        resetCopyState();
        if (phaseRef.current === "final") {
          startHideTimer(FINAL_HIDE_DURATION_MS);
          setCountdownKey((k) => k + 1);
        }
      } catch {
        setCopied(false);
      }
    }
  }, [activeText, resetCopyState, startHideTimer]);

  const handleDismiss = useCallback(() => {
    window.electronAPI?.dismissDictationPreview?.();
  }, []);

  if (!isVisible) {
    return <div className="h-full w-full bg-transparent" />;
  }

  const statusLabel =
    phase === "final"
      ? t("transcriptionPreview.ready", { defaultValue: "Ready" })
      : phase === "cleanup"
        ? t("transcriptionPreview.polishing", { defaultValue: "Polishing..." })
        : t("transcriptionPreview.listening", { defaultValue: "Listening..." });

  return (
    <div className="meeting-notification-window h-full w-full bg-transparent p-2">
      <div
        ref={shellRef}
        className={[
          "relative overflow-hidden rounded-xl border bg-card/92 p-3 backdrop-blur-xl",
          "shadow-[0_8px_24px_rgba(0,0,0,0.14)]",
          "dark:bg-surface-2/92",
          phase === "final"
            ? "border-emerald-500/18 dark:border-emerald-500/20"
            : phase === "cleanup"
              ? "border-accent/22 dark:border-accent/25"
              : "border-border/40 dark:border-border-subtle/45",
          "transition-all duration-200 ease-out",
          isVisible
            ? "translate-y-0 opacity-100 scale-100"
            : "translate-y-4 opacity-0 scale-[0.97]",
        ].join(" ")}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 min-w-0">
            {phase === "final" ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500/70" />
            ) : phase === "cleanup" ? (
              <div className="flex items-end gap-[2px] shrink-0 h-3.5">
                {[5, 9, 7].map((h, i) => (
                  <span
                    key={i}
                    className="w-[2px] rounded-full bg-accent/60"
                    style={{
                      height: h,
                      animation: "preview-bars 0.8s ease-in-out infinite",
                      animationDelay: `${i * 0.1}s`,
                    }}
                  />
                ))}
              </div>
            ) : (
              <span
                className={[
                  "block h-1.5 w-1.5 shrink-0 rounded-full animate-pulse",
                  rawText ? "bg-primary/70" : "bg-muted-foreground/30",
                ].join(" ")}
              />
            )}
            <span className="text-[12px] font-medium tracking-tight text-muted-foreground/70 truncate">
              {statusLabel}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            {activeText ? (
              <button
                onClick={handleCopy}
                className={[
                  "inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium transition-colors",
                  copied
                    ? "border-emerald-500/15 text-emerald-500/70"
                    : "border-border/30 text-muted-foreground/60 hover:border-border/50 hover:bg-background/40 hover:text-foreground/80",
                ].join(" ")}
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied
                  ? t("transcriptionPreview.copied", { defaultValue: "Copied" })
                  : t("transcriptionPreview.copy", { defaultValue: "Copy" })}
              </button>
            ) : null}

            <button
              onClick={handleDismiss}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/40 transition-colors hover:bg-background/40 hover:text-muted-foreground/70"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>

        {activeText && (
          <div className="relative mt-2">
            {hasOverflow && (
              <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-5 rounded-t-lg bg-gradient-to-b from-background/60 to-transparent dark:from-surface-2/60" />
            )}

            <div
              ref={textRef}
              className={[
                "preview-text-scroll rounded-lg border px-2.5 py-2 max-h-[220px] overflow-y-auto",
                phase === "final"
                  ? "border-emerald-500/10 bg-emerald-500/[0.03]"
                  : phase === "cleanup"
                    ? "border-accent/12 bg-accent/[0.03]"
                    : "border-border/25 bg-background/30",
              ].join(" ")}
            >
              <p className="select-text text-[13px] leading-[1.52] text-foreground whitespace-pre-wrap break-words [text-wrap:pretty]">
                {activeText}
              </p>
            </div>
          </div>
        )}

        {phase === "listening" && !rawText && (
          <div className="mt-2 flex items-center gap-2 px-1 py-1">
            <div className="flex items-end gap-[3px]">
              {[8, 13, 10].map((h, i) => (
                <span
                  key={i}
                  className="w-[2px] rounded-full bg-primary/35"
                  style={{
                    height: h,
                    animation: "preview-bars 0.9s ease-in-out infinite",
                    animationDelay: `${i * 0.12}s`,
                  }}
                />
              ))}
            </div>
            <span className="text-[11px] text-muted-foreground/45">
              {t("transcriptionPreview.waitingForInput", { defaultValue: "Say something..." })}
            </span>
          </div>
        )}

        {phase === "final" && (
          <div className="absolute bottom-0 inset-x-0 h-[2px] overflow-hidden rounded-b-xl">
            <div
              key={countdownKey}
              className="h-full rounded-b-xl bg-emerald-500/25"
              style={{ animation: `preview-countdown ${FINAL_HIDE_DURATION_MS}ms linear forwards` }}
            />
          </div>
        )}
      </div>

      <style>{`
        @keyframes preview-bars {
          0%, 100% { transform: scaleY(0.7); opacity: 0.6; }
          50% { transform: scaleY(1.3); opacity: 1; }
        }
        @keyframes preview-countdown {
          from { width: 100%; }
          to { width: 0%; }
        }
        .preview-text-scroll::-webkit-scrollbar { display: none; }
        .preview-text-scroll { scrollbar-width: none; }
      `}</style>
    </div>
  );
}
