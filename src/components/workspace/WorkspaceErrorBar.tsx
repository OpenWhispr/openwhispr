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

// The tone colours the surface and the icon. An error's message is red as well; a warning's stays
// in the foreground colour, since the warning amber is too light for body text on a light page.
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
        "flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm text-primary",
        tone === "error"
          ? "border-red-solid/25 bg-red-solid/10"
          : "border-amber-solid/30 bg-amber-solid/10"
      )}
    >
      <AlertCircle
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "error" ? "text-red-solid" : "text-amber-solid"
        )}
      />
      <p
        className={cn(
          "min-w-0 flex-1 leading-snug break-words",
          tone === "error" && "text-red-solid"
        )}
      >
        {message}
      </p>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="-my-0.5 shrink-0 rounded-full bg-text-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-text-primary/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
