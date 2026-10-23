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
  className,
  ref,
}: DropZoneProps): ReactElement {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onBrowse();
    }
  };

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={label}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragOver(false);
        const files = Array.from(event.dataTransfer.files ?? []);
        if (files.length > 0) onFiles(files);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        setIsDragOver(false);
      }}
      onClick={onBrowse}
      onKeyDown={handleKeyDown}
      className={cn(
        "group mt-6 flex cursor-pointer flex-col items-center rounded-2xl border border-dashed px-6 py-12 text-center",
        "transition-[background-color,border-color,transform] duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
        isDragOver
          ? "scale-[1.01] border-primary/60 bg-primary/5 dark:bg-primary/10"
          : "border-border bg-card/50 hover:border-primary/40 hover:bg-primary/5 dark:border-white/15 dark:bg-surface-2/60 dark:hover:bg-primary/10",
        className
      )}
      style={isDragOver ? { animation: "drag-pulse 1.5s ease-in-out infinite" } : undefined}
    >
      <span
        className={cn(
          "flex h-11 w-11 items-center justify-center rounded-xl transition-colors",
          isDragOver
            ? "bg-primary/15 text-primary"
            : "bg-surface-3 text-foreground/70 group-hover:text-primary"
        )}
      >
        <Upload size={20} />
      </span>
      <p
        className={cn(
          "mt-4 text-[15px] font-medium",
          isDragOver ? "text-primary" : "text-foreground"
        )}
      >
        {isDragOver ? activeLabel : label}
      </p>
      {!isDragOver && hint && (
        <p className="mt-1 max-w-md text-[13px] leading-relaxed text-foreground/60">{hint}</p>
      )}
    </div>
  );
}
