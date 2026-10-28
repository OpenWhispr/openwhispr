import { useState, type KeyboardEvent, type ReactElement, type Ref } from "react";
import { Upload } from "../icons";
import { cn } from "../lib/utils";

interface DropZoneProps {
  /** Shown while idle; also the zone's accessible name. */
  label: string;
  /** Shown while files are dragged over. */
  activeLabel: string;
  hint?: string;
  onFiles: (files: File[]) => void;
  onBrowse: () => void;
  disabled?: boolean;
  describedBy?: string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** A dashed area to drop files on, which also opens the file picker from the keyboard. */
export function DropZone({
  label,
  activeLabel,
  hint,
  onFiles,
  onBrowse,
  disabled = false,
  describedBy,
  className,
  ref,
}: DropZoneProps): ReactElement {
  const [isDragOver, setIsDragOver] = useState(false);

  const showDragOver = isDragOver && !disabled;

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!disabled) onBrowse();
    }
  };

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-describedby={describedBy}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragOver(false);
        if (disabled) return;
        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length > 0) onFiles(files);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setIsDragOver(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        setIsDragOver(false);
      }}
      onClick={() => {
        if (!disabled) onBrowse();
      }}
      onKeyDown={handleKeyDown}
      className={cn(
        "group mt-6 flex flex-col items-center rounded-2xl border border-dashed px-6 py-12 text-center",
        "transition-[background-color,border-color,transform] duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
        disabled
          ? "cursor-not-allowed border-border bg-card/50 opacity-50 dark:border-white/15 dark:bg-surface-2/60"
          : showDragOver
            ? "cursor-pointer scale-[1.01] border-primary/60 bg-primary/5 dark:bg-primary/10"
            : "cursor-pointer border-border bg-card/50 hover:border-primary/40 hover:bg-primary/5 dark:border-white/15 dark:bg-surface-2/60 dark:hover:bg-primary/10",
        className
      )}
      style={showDragOver ? { animation: "drag-pulse 1.5s ease-in-out infinite" } : undefined}
    >
      <span
        className={cn(
          "flex h-11 w-11 items-center justify-center rounded-xl transition-colors",
          showDragOver
            ? "bg-primary/15 text-primary"
            : cn("bg-surface-3 text-foreground/70", !disabled && "group-hover:text-primary")
        )}
      >
        <Upload size={20} />
      </span>
      <p
        className={cn(
          "mt-4 text-[15px] font-medium",
          showDragOver ? "text-primary" : "text-foreground"
        )}
      >
        {showDragOver ? activeLabel : label}
      </p>
      {!showDragOver && hint && (
        <p className="mt-1 max-w-md text-[13px] leading-relaxed text-foreground/60">{hint}</p>
      )}
    </div>
  );
}
