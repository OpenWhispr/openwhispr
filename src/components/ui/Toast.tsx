import * as React from "react";
import { X, Copy, Check } from "lucide-react";
import { cn } from "../lib/utils";

export interface ToastProps {
  id?: string;
  title?: string;
  description?: string;
  action?: React.ReactNode;
  variant?: "default" | "destructive" | "success";
  duration?: number;
  onClose?: () => void;
}

export interface ToastContextType {
  toast: (props: Omit<ToastProps, "id">) => void;
  dismiss: (id?: string) => void;
  toastCount: number;
}

const ToastContext = React.createContext<ToastContextType | undefined>(undefined);

export const useToast = () => {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
};

interface ToastState extends ToastProps {
  id: string;
  isExiting?: boolean;
  createdAt: number;
}

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = React.useState<ToastState[]>([]);
  const timersRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});

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
    (props: Omit<ToastProps, "id">) => {
      const id = Math.random().toString(36).substring(2, 11);
      const newToast: ToastState = { ...props, id, createdAt: Date.now() };

      setToasts((prev) => [...prev, newToast]);

      const duration = props.duration ?? (props.variant === "destructive" ? 6000 : 3500);
      if (duration > 0) {
        const timer = setTimeout(() => {
          startExitAnimation(id);
        }, duration);
        timersRef.current[id] = timer;
      }

      return id;
    },
    [startExitAnimation]
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

  return (
    <ToastContext.Provider value={{ toast, dismiss, toastCount: toasts.length }}>
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
  const isDictationPanel = React.useMemo(() => {
    return (
      window.location.pathname.indexOf("control") === -1 &&
      window.location.search.indexOf("panel=true") === -1
    );
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      className={cn(
        "fixed z-[100] flex flex-col gap-1.5 pointer-events-none",
        isDictationPanel ? "bottom-20 right-6" : "bottom-5 right-5"
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
  action,
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
  const [copied, setCopied] = React.useState(false);
  const isDestructive = variant === "destructive";

  const handleMouseEnter = () => {
    pausedAtRef.current = Date.now();
    onPauseTimer();
  };

  const handleMouseLeave = () => {
    if (pausedAtRef.current && duration > 0) {
      const elapsed = pausedAtRef.current - createdAt;
      const remaining = Math.max(duration - elapsed, 500);
      onResumeTimer(remaining);
    }
    pausedAtRef.current = null;
  };

  const handleCopyError = async () => {
    if (!description) return;
    try {
      await navigator.clipboard.writeText(description);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silently fail
    }
  };

  const message = title || description;
  const detail = title && description ? description : undefined;

  return (
    <div
      className={cn(
        "group toast-surface pointer-events-auto relative flex w-75 overflow-hidden",
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

      <div className="flex items-start gap-2 flex-1 min-w-0 px-2.5 py-2 pr-7">
        <div className="flex-1 min-w-0">
          {message && (
            <div className="text-xs font-medium leading-tight text-white/90">{message}</div>
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
                    onClick={handleCopyError}
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
        </div>

        {action && <div className="shrink-0 self-center">{action}</div>}
      </div>

      {onClose && (
        <button
          onClick={onClose}
          className={cn(
            "absolute right-1 top-1 p-1 rounded-[3px]",
            "text-white/0 group-hover:text-white/50 hover:!text-white/80",
            "hover:bg-white/6",
            "transition-colors duration-150",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-white/20"
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
            }}
          />
        </div>
      )}
    </div>
  );
};

export const toast = {
  success: (message: string) => ({
    title: message,
    variant: "success" as const,
  }),
  error: (message: string) => ({
    title: message,
    variant: "destructive" as const,
  }),
  info: (message: string) => ({
    title: message,
    variant: "default" as const,
  }),
};
