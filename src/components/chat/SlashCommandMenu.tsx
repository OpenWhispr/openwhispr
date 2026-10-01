import { useEffect, useRef } from "react";
import { cn } from "../lib/utils";
import { slashOptionId, type SlashCommand } from "./slashCommands";

interface SlashCommandMenuProps {
  id: string;
  label: string;
  commands: SlashCommand[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onRun: (command: SlashCommand) => void;
  className?: string;
}

/** The command list the composer drives from its keyboard while its draft starts with "/". */
export default function SlashCommandMenu({
  id,
  label,
  commands,
  activeIndex,
  onActiveIndexChange,
  onRun,
  className,
}: SlashCommandMenuProps) {
  const activeRef = useRef<HTMLButtonElement>(null);

  // Arrow keys and a narrowing filter can leave the highlighted row out of view.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, commands]);

  return (
    <div
      id={id}
      role="listbox"
      aria-label={label}
      // A scrolling list is otherwise a tab stop, and Shift+Tab into it would close it.
      tabIndex={-1}
      className={cn("flex flex-col overflow-y-auto", className)}
    >
      {commands.map((command, index) => (
        <button
          key={command.id}
          ref={index === activeIndex ? activeRef : undefined}
          id={slashOptionId(id, index)}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          aria-disabled={command.disabled}
          tabIndex={-1}
          // Keep focus in the composer.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onRun(command)}
          // Move, not enter: rows sliding under a resting pointer as the list filters or
          // scrolls mustn't change which command Enter runs.
          onMouseMove={() => onActiveIndexChange(index)}
          className={cn(
            "flex w-full shrink-0 flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-start text-xs text-foreground/70 transition-colors",
            index === activeIndex && "bg-foreground/5 text-foreground",
            command.disabled ? "cursor-default opacity-40" : "cursor-pointer"
          )}
        >
          <span className="flex w-full items-center gap-1.5">
            <span dir="auto" className="min-w-0 truncate font-medium">
              {command.label}
            </span>
            {command.hint && (
              <span className="shrink-0 rounded bg-foreground/5 px-1 py-px text-[10px] font-medium text-muted-foreground/70 dark:bg-white/6">
                {command.hint}
              </span>
            )}
          </span>
          {command.description && (
            <span dir="auto" className="w-full truncate text-muted-foreground/70">
              {command.description}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
