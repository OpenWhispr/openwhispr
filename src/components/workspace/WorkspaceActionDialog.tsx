import { useRef, type ReactElement, type ReactNode } from "react";
import { Info, Trash2 } from "../icons";
import { cn } from "../lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";

export interface WorkspaceActionDialogProps {
  open: boolean;
  icon: "info" | "trash";
  title: string;
  body: string;
  /** Destructive-text line under the field slot. */
  error?: string | null;
  /** Field slot, e.g. the owner picker. */
  children?: ReactNode;
  primary: {
    label: string;
    onClick: () => void;
    tone: "primary" | "destructive";
    disabled?: boolean;
  };
  /** Omitted: no Cancel button. */
  cancelLabel?: string;
  /** Disables the primary, hides Cancel and blocks Esc and overlay dismissal. */
  busy?: boolean;
  onDismiss: () => void;
}

const BUTTON_BASE =
  "flex h-10 w-full items-center justify-center rounded-full px-4 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";

export function WorkspaceActionDialog({
  open,
  icon,
  title,
  body,
  error,
  children,
  primary,
  cancelLabel,
  busy = false,
  onDismiss,
}: WorkspaceActionDialogProps): ReactElement {
  const Icon = icon === "trash" ? Trash2 : Info;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const showCancel = Boolean(cancelLabel) && !busy;

  // A running leave, delete or transfer can't be taken back, so Esc and an
  // overlay click must not close the window that is reporting it.
  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen && !busy) onDismiss();
  };

  // Radix focuses the first control, which here is the primary. Starting on
  // Cancel keeps a stray Enter from confirming a delete or leave.
  const focusCancelOnOpen =
    primary.tone === "destructive" && showCancel
      ? (event: Event): void => {
          event.preventDefault();
          cancelRef.current?.focus();
        }
      : undefined;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        hideCloseButton
        onOpenAutoFocus={focusCancelOnOpen}
        className="w-[420px] max-w-[calc(100vw-32px)] items-stretch gap-7 rounded-[28px] p-5 sm:max-w-[420px]"
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-[42px] items-center justify-center rounded-full bg-surface-3 text-foreground">
            <Icon className="size-3.5" aria-hidden="true" />
          </div>
          <DialogTitle className="text-lg font-medium tracking-normal leading-snug">
            {title}
          </DialogTitle>
          <DialogDescription className="text-sm leading-normal">{body}</DialogDescription>
        </div>

        {children}

        {error ? (
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={primary.onClick}
            disabled={busy || primary.disabled}
            className={cn(
              BUTTON_BASE,
              primary.tone === "destructive"
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "bg-primary text-primary-foreground hover:bg-primary/90"
            )}
          >
            {primary.label}
          </button>
          {showCancel ? (
            <button
              ref={cancelRef}
              type="button"
              onClick={onDismiss}
              className={cn(
                BUTTON_BASE,
                "bg-surface-1 text-muted-foreground hover:bg-surface-3 hover:text-foreground"
              )}
            >
              {cancelLabel}
            </button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
