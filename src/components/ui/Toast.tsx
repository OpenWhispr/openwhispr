import * as React from "react";
import { Copy, Check } from "../icons";
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
import { ToastCard } from "./ToastCard";
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
  // A toast can start leaving twice (its timer, then a dismiss during the exit animation).
  const settledRef = React.useRef(new Set<string>());

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
    const leaving = toastsRef.current.find((item) => item.id === id);
    if (leaving?.onSettled && !settledRef.current.has(id)) {
      settledRef.current.add(id);
      leaving.onSettled();
    }
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, isExiting: true } : t)));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      settledRef.current.delete(id);
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
        const lastToast = toastsRef.current[toastsRef.current.length - 1];
        if (lastToast) {
          clearTimer(lastToast.id);
          startExitAnimation(lastToast.id);
        }
      }
    },
    [clearTimer, startExitAnimation]
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

  // A live preview can keep the native window short. Safe end alignment lets
  // taller standard cards start below the top gutter instead of clipping Close.

  return (
    <div
      data-toast-viewport=""
      data-toast-stack
      className={cn(
        "fixed z-[100] flex flex-col gap-2 pointer-events-none",
        isDictationPanel
          ? hasDictationError
            ? "inset-x-3 bottom-3 [&>*]:w-full [&>*]:max-w-none"
            : "top-4 bottom-20 end-6 justify-end-safe"
          : "bottom-5 end-5",
        isDictationPanel &&
          !hasDictationError &&
          toasts.length > 1 &&
          "pointer-events-auto -m-2 overflow-y-auto p-2"
      )}
    >
      {toasts.map((toast) => (
        <Toast
          key={toast.id}
          {...toast}
          onClose={() => {
            try {
              toast.onClose?.();
            } finally {
              onDismiss(toast.id);
            }
          }}
          onPauseTimer={() => onPauseTimer(toast.id)}
          onResumeTimer={(remaining) => onResumeTimer(toast.id, remaining)}
        />
      ))}
    </div>
  );
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
  descriptionHotkey,
  dismissible,
  secondaryDescription,
  copyCommand,
  technicalDetails,
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
    return structuredAction.onClick();
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

  // Structured actions or a recovery command come with a classified error whose
  // description is a sentence to read; otherwise a destructive one is the raw error.
  const rawError =
    isDestructive && !actions?.length && !copyCommand && title ? description : undefined;

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
          descriptionHotkey={descriptionHotkey}
          onDismiss={dismissible ? onClose : undefined}
          actions={actions ?? []}
          onAction={handleStructuredAction}
          role={isDestructive ? "alert" : "status"}
          tone={isDestructive ? "error" : undefined}
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
        "pointer-events-auto shrink-0 w-100 max-w-[calc(100vw-3rem)]",
        "transition-[opacity,transform] duration-200 ease-out",
        isExiting
          ? "opacity-0 translate-x-2 rtl:-translate-x-2 scale-[0.98]"
          : "toast-enter opacity-100 translate-x-0 scale-100"
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <ToastCard
        title={title}
        description={rawError ? undefined : description}
        descriptionHotkey={descriptionHotkey}
        role={isDestructive ? "alert" : "status"}
        tone={isDestructive ? "error" : variant === "success" ? "success" : undefined}
        onDismiss={onClose}
        actions={actions ?? []}
        onAction={handleStructuredAction}
        progressDuration={!isExiting ? duration : 0}
        progressPaused={timerPaused}
      >
        {secondaryDescription && (
          <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
            {secondaryDescription}
          </p>
        )}
        {rawError && (
          <div className="mt-2 flex items-start justify-between gap-1.5 rounded-lg border border-border/60 bg-foreground/5 px-2 py-1.5 font-mono text-xs leading-snug text-destructive">
            <span className="min-w-0 select-all wrap-break-word">{rawError}</span>
            <button
              type="button"
              onClick={() => void copy()}
              className="shrink-0 rounded-xs p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              aria-label={t("common.copy")}
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
            </button>
          </div>
        )}
        {copyCommand && (
          <div className="mt-2 flex items-center gap-1.5 rounded-lg border border-border/60 bg-foreground/5 px-2 py-1.5">
            <code
              dir="ltr"
              className="min-w-0 flex-1 wrap-break-word font-mono text-xs text-muted-foreground select-all"
            >
              {copyCommand}
            </code>
            <button
              type="button"
              onClick={() => void copyRecoveryCommand()}
              className="shrink-0 rounded-xs p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              aria-label={t("reasoning.enterprise.technicalDetails.copyCommand")}
            >
              {commandCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
            </button>
          </div>
        )}
        <TechnicalErrorDetails details={technicalDetails} />
      </ToastCard>
    </div>
  );
};
