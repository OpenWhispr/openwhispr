import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { Check, X } from "../icons";
import { cn } from "../lib/utils";
import type { ToastActionConfig } from "./useToast";
import { TOAST_ACTION_ICONS } from "./toastActionIcons";

export interface ToastCardProps {
  title?: string;
  description?: string;
  descriptionHotkey?: string;
  /** Extra content under the description: a recovery command, technical details. */
  children?: ReactNode;
  actions: ToastActionConfig[];
  onAction: (action: ToastActionConfig) => ReturnType<ToastActionConfig["onClick"]>;
  onDismiss?: () => void;
  progressDuration?: number;
  progressPaused?: boolean;
  ready?: boolean;
  /** "alert" interrupts a screen reader; "status" waits for it to finish speaking. */
  role?: "alert" | "status";
  ref?: Ref<HTMLElement>;
}

function ToastCardAction({
  action,
  primary,
  onAction,
}: {
  action: ToastActionConfig;
  primary: boolean;
  onAction: ToastCardProps["onAction"];
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<boolean | undefined>();
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(resetTimer.current);
    };
  }, []);

  const handleClick = async () => {
    if (!action.feedback) {
      return onAction(action);
    }
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setResult(undefined);
    clearTimeout(resetTimer.current);
    let outcome: void | boolean;
    try {
      outcome = await onAction(action);
    } catch {
      outcome = false;
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
    if (!mountedRef.current || typeof outcome !== "boolean") return;
    setResult(outcome);
    resetTimer.current = setTimeout(() => setResult(undefined), 1800);
  };

  const Icon = result === true ? Check : action.icon ? TOAST_ACTION_ICONS[action.icon] : null;
  const label =
    result === true
      ? action.feedback?.successLabel
      : result === false
        ? action.feedback?.failureLabel
        : action.label;
  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={pending}
      title={action.iconOnly ? label : undefined}
      className={cn(
        "inline-flex h-8 min-w-0 shrink-0 items-center justify-center gap-1.5 rounded-full",
        action.iconOnly ? "w-8" : "px-4",
        "text-sm font-medium transition-[background-color,color,transform] duration-150",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-[0.98] disabled:cursor-wait",
        primary
          ? "bg-foreground text-background hover:bg-foreground/90"
          : "bg-foreground/15 text-foreground hover:bg-foreground/20"
      )}
    >
      {Icon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
      <span
        className={action.iconOnly ? "sr-only" : "truncate"}
        aria-live={action.feedback ? "polite" : undefined}
      >
        {label}
      </span>
    </button>
  );
}

function ToastCardDescription({ text, hotkey }: { text: string; hotkey?: string }) {
  const start = hotkey ? text.indexOf(hotkey) : -1;
  if (!hotkey || start < 0) return text;
  return (
    <>
      {text.slice(0, start)}
      <span
        dir="ltr"
        role="img"
        aria-label={hotkey}
        className="inline-flex items-center gap-1 whitespace-nowrap align-baseline"
      >
        {hotkey.split("+").map((key, index) => (
          <span
            key={`${key}-${index}`}
            aria-hidden="true"
            className="inline-flex items-center gap-1"
          >
            {index > 0 && <span className="text-xs">+</span>}
            <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-surface-raised px-1 font-sans text-[11px] font-medium text-foreground shadow-sm">
              {key === "Cmd" ? "⌘" : key}
            </kbd>
          </span>
        ))}
      </span>
      {text.slice(start + hotkey.length)}
    </>
  );
}

/** The one toast surface: title, description, actions, a close button and a progress edge. */
export function ToastCard({
  title,
  description,
  descriptionHotkey,
  children,
  actions,
  onAction,
  onDismiss,
  progressDuration = 0,
  progressPaused = false,
  ready = true,
  role = "alert",
  ref,
}: ToastCardProps) {
  const { t } = useTranslation();
  const hasSecondaryAction = actions.length > 1;
  // A single action beside the text already keeps the text clear of the close button.
  const besideAction = actions.length === 1;
  const textClearsClose = onDismiss && !besideAction;

  const text = (
    <div className="min-w-0 flex-1 break-words px-2 py-1">
      {title && (
        <p
          className={cn(
            "text-base font-normal leading-snug text-foreground",
            textClearsClose && "pe-7"
          )}
        >
          {title}
        </p>
      )}
      {description && (
        <p
          className={cn(
            "whitespace-pre-wrap text-sm leading-snug text-muted-foreground",
            title ? "mt-1" : textClearsClose && "pe-7"
          )}
        >
          <ToastCardDescription text={description} hotkey={descriptionHotkey} />
        </p>
      )}
      {children}
    </div>
  );

  const renderAction = (action: ToastActionConfig, index: number) => (
    <ToastCardAction
      key={`${action.label}-${index}`}
      action={action}
      primary={index === 0 && !action.iconOnly}
      onAction={onAction}
    />
  );

  // Up to two labelled actions share one row with the icon-only ones after them.
  const labelledActions = actions.filter((action) => !action.iconOnly);
  const iconActions = actions.filter((action) => action.iconOnly);
  const singleRow = labelledActions.length <= 2;
  const rowActions = singleRow ? [...labelledActions, ...iconActions] : actions;

  return (
    <section
      ref={ref}
      role={role}
      aria-live={role === "alert" ? "assertive" : "polite"}
      data-action-count={actions.length}
      className={cn(
        "relative max-h-[calc(100vh-1.5rem)] w-full overflow-y-auto rounded-2xl border border-border/50 bg-surface-0",
        "shadow-[var(--shadow-modal)] transition-[opacity,transform] duration-200 ease-out",
        ready ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-1 opacity-0"
      )}
    >
      {progressDuration > 0 && (
        <svg
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-4 w-full overflow-visible text-foreground"
          viewBox="0 0 442 17"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            d="M 1 16 A 15 15 0 0 1 16 1 H 426 A 15 15 0 0 1 441 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            strokeLinecap="butt"
            pathLength="1"
            strokeDasharray="1"
            style={{
              animation: `toast-border-progress ${progressDuration}ms linear forwards`,
              animationPlayState: progressPaused ? "paused" : "running",
            }}
          />
        </svg>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("common.close")}
          className="absolute end-2 top-2 z-10 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}
      {hasSecondaryAction ? (
        <div className="px-2 py-3">
          {text}
          <div
            className={cn("mt-3 grid gap-2", !singleRow && "grid-cols-2")}
            style={
              singleRow
                ? {
                    gridTemplateColumns: [
                      ...labelledActions.map(() => "minmax(0, 1fr)"),
                      ...iconActions.map(() => "2rem"),
                    ].join(" "),
                  }
                : undefined
            }
          >
            {rowActions.map(renderAction)}
          </div>
        </div>
      ) : (
        // The action stays clear of the close button's column.
        <div
          className={cn("flex items-center gap-2 px-2 py-3", onDismiss && besideAction && "pe-10")}
        >
          {text}
          {actions.slice(0, 1).map(renderAction)}
        </div>
      )}
    </section>
  );
}
