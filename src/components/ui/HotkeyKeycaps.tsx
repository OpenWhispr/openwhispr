import { cn } from "../lib/utils";
import { formatHotkeyLabel } from "../../utils/hotkeys";

interface HotkeyKeycapsProps {
  hotkey: string;
  className?: string;
}

/** One hotkey as keycap tokens — the same tokens the hands-free tip card uses. */
export function HotkeyKeycaps({ hotkey, className }: HotkeyKeycapsProps) {
  const parts = formatHotkeyLabel(hotkey).split("+");
  return (
    <span className={cn("whitespace-nowrap", className)}>
      {parts.map((part, index) => (
        <span key={`${part}-${index}`}>
          {index > 0 && " + "}
          <kbd className="rounded-md border border-border/40 bg-foreground/5 px-1.5 py-0.5 font-mono text-[12px] text-foreground/65 shadow-sm">
            {part}
          </kbd>
        </span>
      ))}
    </span>
  );
}
