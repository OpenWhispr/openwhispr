import { Check, IconComponent } from "../icons";
import { cn } from "../lib/utils";

interface OptionCardProps {
  icon: IconComponent;
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
        "group relative w-full rounded-md p-3 text-start transition-colors duration-150",
        "border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-surface-primary",
        selected
          ? "bg-brand-solid/5 border-brand-solid/40 dark:bg-brand-solid/10 dark:border-brand-solid/30"
          : "bg-surface-secondary border-default hover:bg-surface-primary hover:border-hover",
        disabled && "cursor-not-allowed border-default bg-surface-secondary text-secondary"
      )}
    >
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors duration-150",
            selected
              ? "bg-brand-solid/15 dark:bg-brand-solid/20"
              : "bg-brand-solid/10 dark:bg-brand-solid/15 group-hover:bg-brand-solid/15"
          )}
        >
          <Icon className="w-4 h-4 text-brand-solid" />
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-medium text-primary">{title}</h3>
          <p className="text-xs text-secondary leading-snug mt-0.5">{description}</p>
        </div>

        <div
          className={cn(
            "w-4 h-4 rounded-sm border flex items-center justify-center shrink-0 transition-colors duration-150",
            selected ? "bg-brand-solid border-brand-solid" : "border-hover bg-transparent"
          )}
        >
          {selected && <Check className="w-3 h-3 text-on-solid" strokeWidth={3} />}
        </div>
      </div>
    </button>
  );
}
