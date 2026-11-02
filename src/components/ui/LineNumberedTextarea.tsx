import { useRef, type ReactElement, type Ref } from "react";
import { cn } from "../lib/utils";

interface LineNumberedTextareaProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** The gutter shows at least this many lines, so an empty editor still looks like one. */
  minLines?: number;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
  ariaLabel?: string;
  ref?: Ref<HTMLTextAreaElement>;
}

/** A plain-text editor with line numbers beside it, safe in dark mode. */
export function LineNumberedTextarea({
  id,
  value,
  onChange,
  placeholder,
  minLines = 10,
  invalid = false,
  describedBy,
  className,
  ariaLabel,
  ref,
}: LineNumberedTextareaProps): ReactElement {
  const gutter = useRef<HTMLDivElement>(null);
  const lineCount = Math.max(minLines, value.split("\n").length);

  return (
    // The box has the height, so a long text overflows the gutter and the textarea alike and
    // the gutter can follow the textarea's scroll. Lines don't wrap, so each number stays
    // beside its line; the gutter's extra bottom room matches a sideways scrollbar's.
    <div
      className={cn(
        "flex h-56 overflow-hidden rounded-lg border border-border/70 bg-input transition-colors hover:border-border-hover focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/10 dark:border-border-subtle/60 dark:bg-surface-1 dark:focus-within:border-border-active dark:focus-within:ring-ring/10",
        invalid && "border-destructive! ring-destructive/20 dark:ring-destructive/40",
        className
      )}
    >
      <div
        ref={gutter}
        aria-hidden="true"
        className="select-none overflow-hidden border-e border-border/60 dark:border-white/8 bg-foreground/3 dark:bg-white/3 pt-2 pb-3.5 ps-3 pe-2 text-end font-mono text-[11px] leading-5 text-muted-foreground/50 tabular-nums"
      >
        {Array.from({ length: lineCount }, (_, index) => (
          <div key={index}>{index + 1}</div>
        ))}
      </div>
      <textarea
        ref={ref}
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
        }}
        placeholder={placeholder}
        rows={minLines}
        wrap="off"
        dir="auto"
        spellCheck={false}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className="input-inline block h-full min-w-0 flex-1 resize-none overflow-auto bg-transparent px-3 py-2 font-mono text-xs leading-5 text-foreground outline-none placeholder:text-muted-foreground/50 caret-primary"
      />
    </div>
  );
}
