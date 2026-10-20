import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useDirection } from "@radix-ui/react-direction";
import { isArrowKey, logicalArrowKey } from "../../lib/arrowKeys";
import { cn } from "../lib/utils";

export interface RadioGroupOption {
  value: string;
  label: ReactNode;
}

interface RadioGroupProps {
  options: readonly RadioGroupOption[];
  /** The picked option's value; none is picked until the user picks one. */
  value: string | undefined;
  onValueChange: (value: string) => void;
  "aria-label"?: string;
  className?: string;
}

/**
 * One choice from a list. The arrow keys move focus (mirrored right-to-left)
 * and Space or Enter picks, so moving through the options never answers for
 * the user; one tab stop, on the picked option or the first.
 */
export function RadioGroup({
  options,
  value,
  onValueChange,
  "aria-label": ariaLabel,
  className,
}: RadioGroupProps) {
  const direction = useDirection();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pickedIndex = options.findIndex((option) => option.value === value);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const tabStop =
    focusIndex !== null && focusIndex < options.length ? focusIndex : Math.max(0, pickedIndex);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      onValueChange(options[index].value);
      return;
    }
    if (!isArrowKey(event.key)) return;
    event.preventDefault();
    const key = logicalArrowKey(event.key, direction);
    const step = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
    const next = (index + step + options.length) % options.length;
    setFocusIndex(next);
    optionRefs.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("flex flex-col", className)}>
      {options.map((option, index) => {
        const checked = index === pickedIndex;
        return (
          <button
            key={option.value}
            ref={(node) => {
              optionRefs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === tabStop ? 0 : -1}
            onClick={() => onValueChange(option.value)}
            onFocus={() => setFocusIndex(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className="flex w-full items-center gap-3 rounded-md py-1.5 text-start text-[14px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                checked ? "border-foreground/40" : "border-foreground/20"
              )}
            >
              {checked && <span className="size-2 rounded-full bg-foreground" />}
            </span>
            <span dir="auto" className="min-w-0 flex-1">
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
