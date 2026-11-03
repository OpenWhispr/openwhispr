import type { ReactElement, ReactNode } from "react";
import { AlertCircle } from "../icons";
import { cn } from "../lib/utils";

export interface WorkspaceErrorBarProps {
  /** Lets the field the error is about point at it with `aria-describedby`. */
  id?: string;
  tone: "error" | "warning";
  /** A string, or text with an isolated value (`BidiInterpolatedText`). */
  message: ReactNode;
  action?: { label: string; onClick: () => void };
}

// The tone colors the surface and the icon only; the message stays in the foreground color,
// since the warning amber is too light for body text on a light background.
export function WorkspaceErrorBar({
  id,
  tone,
  message,
  action,
}: WorkspaceErrorBarProps): ReactElement {
  return (
    <div
      id={id}
      role="alert"
      className={cn(
        "flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm text-foreground",
        tone === "error"
          ? "border-destructive/25 bg-destructive/10"
          : "border-warning/30 bg-warning/10"
      )}
    >
      <AlertCircle
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "error" ? "text-destructive" : "text-warning"
        )}
      />
      <p className="min-w-0 flex-1 leading-snug break-words">{message}</p>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="-my-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-sm font-medium text-foreground underline-offset-2 transition-colors hover:bg-foreground/5 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
