import * as React from "react";
import { X, Copy, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import {
  ToastContext,
  type ToastActionConfig,
  type ToastPresentation,
  type ToastProps,
} from "./useToast";
import { isDictationPanelWindow } from "../../utils/windowContext";
import {
  getDictationErrorActionCount,
  getDictationErrorDuration,
  resolveToastPresentation,
} from "../../helpers/toastPresentation";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { DictationErrorCard } from "../dictation/DictationErrorCard";
import { TechnicalErrorDetails } from "./TechnicalErrorDetails";

interface ToastState extends ToastProps {
  id: string;
  isExiting?: boolean;
  createdAt: number;
}

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = React.useState<ToastState[]>([]);
  const toastsRef = React.useRef<ToastState[]>([]);
  const timersRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  React.useEffect(() => {
    toastsRef.current = toasts;
  }, [toasts]);

  const clearTimer = React.useCallback((id: string) => {
    const timer = timersRef.current[id];
    if (timer) {
      clearTimeout(timer);
      delete timersRef.current[id];
    }
  }, []);

  const startExitAnimation = React.useCallback((id: string) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, isExiting: true } : t)));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 200);
  }, []);

  const toast = React.useCallback(
    (props: Omit<ToastProps, "id">): string => {
      const id = Math.random().toString(36).substring(2, 11);
      const presentation = resolveToastPresentation({
        presentation: props.presentation,
        variant: props.variant,
        isDictationPanel: isDictationPanelWindow(),
      });
      const duration =
        props.duration ??
        (presentation === "dictation-error"
          ? getDictationErrorDuration(props.title, props.description)
          : props.variant === "destructive"
            ? 6000
            : 3500);
      const newToast: ToastState = {
        ...props,
        presentation,
        duration,
        id,
        createdAt: Date.now(),
      };

      if (presentation === "dictation-error") {
        // The new error replaces any current one; its auto-dismiss timer must
        // not fire (and re-schedule exit work) for the removed toast.
        for (const item of toastsRef.current) {
          if (item.presentation === "dictation-error") clearTimer(item.id);
        }
      }
      setToasts((prev) =>
        presentation === "dictation-error"
          ? [...prev.filter((item) => item.presentation !== "dictation-error"), newToast]
          : [...prev, newToast]
      );
      // Mirror synchronously: dismissByPresentation can run from a child's
      // effect in the same commit, before this provider's effect refreshes
      // toastsRef from state.
      toastsRef.current =
        presentation === "dictation-error"
          ? [
              ...toastsRef.current.filter((item) => item.presentation !== "dictation-error"),
              newToast,
            ]
          : [...toastsRef.current, newToast];

      if (duration > 0) {
        const timer = setTimeout(() => {
          startExitAnimation(id);
        }, duration);
        timersRef.current[id] = timer;
      }

      return id;
    },
    [clearTimer, startExitAnimation]
  );

  const dismissByPresentation = React.useCallback(
    (presentation: ToastPresentation) => {
      for (const item of toastsRef.current) {
        if (item.presentation !== presentation) continue;
        clearTimer(item.id);
        startExitAnimation(item.id);
      }
    },
    [clearTimer, startExitAnimation]
  );

  const dismiss = React.useCallback(
    (id?: string) => {
      if (id) {
        clearTimer(id);
        startExitAnimation(id);
      } else {
        const lastToast = toasts[toasts.length - 1];
        if (lastToast) {
          clearTimer(lastToast.id);
          startExitAnimation(lastToast.id);
        }
      }
    },
    [toasts, clearTimer, startExitAnimation]
  );

  const pauseTimer = React.useCallback(
    (id: string) => {
      clearTimer(id);
    },
    [clearTimer]
  );

  const resumeTimer = React.useCallback(
    (id: string, remainingTime: number) => {
      if (remainingTime > 0) {
        const timer = setTimeout(() => {
          startExitAnimation(id);
        }, remainingTime);
        timersRef.current[id] = timer;
      }
    },
    [startExitAnimation]
  );

  React.useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const id in timers) {
        clearTimeout(timers[id]);
      }
    };
  }, []);

  const dictationErrorActionCount = getDictationErrorActionCount(toasts);

  return (
    <ToastContext.Provider
      value={{
        toast,
        dismiss,
        toastCount: toasts.length,
        dictationErrorActionCount,
        dismissByPresentation,
      }}
    >
      {children}
      <ToastViewport
        toasts={toasts}
        onDismiss={dismiss}
        onPauseTimer={pauseTimer}
        onResumeTimer={resumeTimer}
      />
    </ToastContext.Provider>
  );
};

const ToastViewport: React.FC<{
  toasts: ToastState[];
  onDismiss: (id: string) => void;
  onPauseTimer: (id: string) => void;
  onResumeTimer: (id: string, remainingTime: number) => void;
}> = ({ toasts, onDismiss, onPauseTimer, onResumeTimer }) => {
  const isDictationPanel = React.useMemo(isDictationPanelWindow, []);
  // Keep the error viewport anchored through its exit animation so the card
  // does not jump back to the standard toast position while fading out.
  const hasDictationError = toasts.some((toast) => toast.presentation === "dictation-error");

  if (toasts.length === 0) return null;

  return (
    <div
      className={cn(
        "fixed z-[100] flex flex-col gap-1.5 pointer-events-none",
        isDictationPanel
          ? hasDictationError
            ? "inset-x-3 bottom-3"
            : "bottom-20 right-6"
          : "bottom-5 right-5"
      )}
    >
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          {...toast}
          onClose={() => onDismiss(toast.id)}
          onPauseTimer={() => onPauseTimer(toast.id)}
          onResumeTimer={(remaining) => onResumeTimer(toast.id, remaining)}
        />
      ))}
    </div>
  );
};

const variantConfig = {
  default: {
    accentClass: "bg-white/20",
    progressClass: "bg-white/15",
  },
  destructive: {
    accentClass: "bg-red-400",
    progressClass: "bg-red-400/30",
  },
  success: {
    accentClass: "bg-emerald-400",
    progressClass: "bg-emerald-400/30",
  },
};

const Toast: React.FC<
  ToastState & {
    onClose?: () => void;
    onPauseTimer: () => void;
    onResumeTimer: (remaining: number) => void;
  }
> = ({
  title,
  description,
  secondaryDescription,
  copyCommand,
  technicalDetails,
  action,
  actions,
  presentation = "standard",
  variant = "default",
  duration = 3500,
  isExiting,
  createdAt,
  onClose,
  onPauseTimer,
  onResumeTimer,
}) => {
  const config = variantConfig[variant];
  const pausedAtRef = React.useRef<number | null>(null);
  const remainingDurationRef = React.useRef(duration);
  const timerStartedAtRef = React.useRef(createdAt);
  const { copied, copy } = useCopyFeedback(description ?? "", { resetMs: 2000 });
  const { copied: commandCopied, copy: copyRecoveryCommand } = useCopyFeedback(copyCommand ?? "", {
    resetMs: 2000,
  });
  const { t } = useTranslation();
  const [timerPaused, setTimerPaused] = React.useState(false);
  const [errorSurfaceReady, setErrorSurfaceReady] = React.useState(false);
  const isDestructive = variant === "destructive";

  React.useEffect(() => {
    if (presentation !== "dictation-error" || errorSurfaceReady) return undefined;

    // Native error sizing is an enhancement, not a visibility gate. A resize
    // acknowledgment can be delayed or skipped when another panel is handing
    // off the same BrowserWindow, so always reveal the already-mounted card
    // after a short grace period instead of leaving it permanently transparent.
    const fallbackTimer = setTimeout(() => {
      requestAnimationFrame(() => setErrorSurfaceReady(true));
    }, 240);
    return () => clearTimeout(fallbackTimer);
  }, [errorSurfaceReady, presentation]);

  const handleStructuredAction = (structuredAction: ToastActionConfig) => {
    if (structuredAction.dismissOnClick !== false) onClose?.();
    void structuredAction.onClick();
  };

  const handleErrorHeightChange = React.useCallback(async (height: number) => {
    try {
      await window.electronAPI?.resizeDictationErrorWindowToContent?.(height);
    } finally {
      // A failed or superseded content-height request must never suppress the
      // actual warning. The initial DICTATION_ERROR width is already usable.
      requestAnimationFrame(() => setErrorSurfaceReady(true));
    }
  }, []);

  const handleMouseEnter = () => {
    if (pausedAtRef.current !== null || duration <= 0) return;
    const now = Date.now();
    remainingDurationRef.current = Math.max(
      0,
      remainingDurationRef.current - (now - timerStartedAtRef.current)
    );
    pausedAtRef.current = now;
    setTimerPaused(true);
    onPauseTimer();
  };

  const handleMouseLeave = () => {
    if (pausedAtRef.current !== null && duration > 0) {
      const remaining = Math.max(remainingDurationRef.current, 500);
      timerStartedAtRef.current = Date.now();
      setTimerPaused(false);
      onResumeTimer(remaining);
    }
    pausedAtRef.current = null;
  };

  const message = title || description;
  const detail = title && description ? description : undefined;

  if (presentation === "dictation-error") {
    return (
      <div
        className={cn(
          "pointer-events-auto w-full transition-[opacity,transform] duration-200 ease-out",
          isExiting ? "translate-y-2 scale-[0.98] opacity-0" : "translate-y-0 scale-100 opacity-100"
        )}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <DictationErrorCard
          title={title}
          description={description}
          actions={actions ?? []}
          onAction={handleStructuredAction}
          onPreferredHeightChange={handleErrorHeightChange}
          progressDuration={!isExiting ? duration : 0}
          progressPaused={timerPaused}
          ready={errorSurfaceReady}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group toast-surface pointer-events-auto relative flex w-75",
        "rounded-[5px]",
        "transition-[opacity,transform] duration-200 ease-out",
        isExiting
          ? "opacity-0 translate-x-2 scale-[0.98]"
          : "opacity-100 translate-x-0 scale-100 animate-in slide-in-from-right-4 fade-in-0 duration-300"
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className={cn("w-0.5 shrink-0", config.accentClass)} />

      <div className="flex items-start gap-2 flex-1 min-w-0 px-2.5 py-2">
        <div className="flex-1 min-w-0">
          {message && (
            <div className="text-xs font-medium leading-tight text-white/90">{message}</div>
          )}
          {secondaryDescription && (
            <div className="mt-1 text-xs leading-snug text-white/45">{secondaryDescription}</div>
          )}
          {detail &&
            (isDestructive ? (
              <div
                className={cn(
                  "text-xs leading-snug mt-1 px-1.5 py-1 rounded-[3px] font-mono",
                  "bg-white/4 border border-white/6",
                  "text-red-300/80"
                )}
              >
                <div className="flex items-start justify-between gap-1.5">
                  <span className="select-all wrap-break-word min-w-0">{detail}</span>
                  <button
                    onClick={() => void copy()}
                    className={cn(
                      "shrink-0 p-0.5 rounded-xs mt-px",
                      "text-white/30 hover:text-white/70",
                      "hover:bg-white/6",
                      "transition-colors duration-150"
                    )}
                    aria-label="Copy error"
                  >
                    {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-xs leading-snug mt-0.5 text-white/45">{detail}</div>
            ))}
          {copyCommand && (
            <div className="mt-1.5 flex items-center gap-1.5 rounded-[3px] border border-white/6 bg-white/4 px-1.5 py-1">
              <code className="min-w-0 flex-1 wrap-break-word font-mono text-[11px] text-white/60 select-all">
                {copyCommand}
              </code>
              <button
                type="button"
                onClick={() => void copyRecoveryCommand()}
                className="shrink-0 rounded-xs p-1 text-white/30 transition-colors hover:bg-white/6 hover:text-white/70"
                aria-label={t("reasoning.enterprise.technicalDetails.copyCommand")}
              >
                {commandCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
              </button>
            </div>
          )}
          <TechnicalErrorDetails details={technicalDetails} onDark />
        </div>

        {action && <div className="shrink-0 self-center">{action}</div>}
      </div>

      {onClose && (
        <button
          onClick={onClose}
          className={cn(
            "absolute -left-2 -top-2 size-6 rounded-full",
            "flex items-center justify-center",
            "bg-white/10 backdrop-blur-sm border border-white/10",
            "text-white/70 hover:text-white hover:bg-white/20",
            "opacity-0 scale-75 group-hover:opacity-100 group-hover:scale-100",
            "transition-all duration-150",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
          )}
        >
          <X className="size-3" />
          <span className="sr-only">Close</span>
        </button>
      )}

      {duration > 0 && !isExiting && (
        <div className="absolute bottom-0 left-0.5 right-0 h-px overflow-hidden">
          <div
            className={cn("h-full", config.progressClass)}
            style={{
              animation: `toast-progress ${duration}ms linear forwards`,
              animationPlayState: timerPaused ? "paused" : "running",
            }}
          />
        </div>
      )}
    </div>
  );
};
