import { ArrowUp } from "../../icons";
import { cn } from "../../lib/utils";
import { ROUND_BUTTON } from "./cardStyles";

/** The round ↑ that submits a card's field; blue once there is something to send. */
export function SubmitArrowButton({ label, disabled }: { label: string; disabled: boolean }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        ROUND_BUTTON,
        !disabled && "bg-primary text-primary-foreground hover:bg-primary hover:brightness-110"
      )}
    >
      <ArrowUp size={16} />
    </button>
  );
}
