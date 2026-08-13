import { Check, LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";

interface OptionCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}

export default function OptionCard({
  icon: Icon,
  title,
  description,
  selected,
  onSelect,
  disabled = false,
}: OptionCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "group relative w-full rounded-md p-3 text-left transition-colors duration-150",
        "border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        selected
          ? "bg-primary/5 border-primary/40 dark:bg-primary/10 dark:border-primary/30"
          : "bg-surface-1 border-border hover:bg-surface-2 hover:border-border-hover",
        disabled && "cursor-not-allowed border-border-subtle bg-muted text-muted-foreground"
      )}
    >
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors duration-150",
            selected
              ? "bg-primary/15 dark:bg-primary/20"
              : "bg-primary/10 dark:bg-primary/15 group-hover:bg-primary/15"
          )}
        >
          <Icon className="w-4 h-4 text-primary" />
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-medium text-foreground">{title}</h3>
          <p className="text-xs text-muted-foreground leading-snug mt-0.5">{description}</p>
        </div>

        <div
          className={cn(
            "w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 transition-colors duration-150",
            selected ? "bg-primary border-primary" : "border-border-hover bg-transparent"
          )}
        >
          {selected && <Check className="w-3 h-3 text-primary-foreground" strokeWidth={3} />}
        </div>
      </div>
    </button>
  );
}
