import { cn } from "../lib/utils";
import { slashOptionId, type SlashCommand } from "./slashCommands";

interface SlashCommandMenuProps {
  id: string;
  label: string;
  commands: SlashCommand[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onRun: (command: SlashCommand) => void;
}

/** The command list the composer drives from its keyboard while its draft starts with "/". */
export default function SlashCommandMenu({
  id,
  label,
  commands,
  activeIndex,
  onActiveIndexChange,
  onRun,
}: SlashCommandMenuProps) {
  return (
    <div id={id} role="listbox" aria-label={label} className="flex flex-col">
      {commands.map((command, index) => (
        <button
          key={command.id}
          id={slashOptionId(id, index)}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          aria-disabled={command.disabled}
          tabIndex={-1}
          // Keep focus in the composer.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onRun(command)}
          onMouseEnter={() => onActiveIndexChange(index)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs text-foreground/70 transition-colors",
            index === activeIndex && "bg-foreground/5 text-foreground",
            command.disabled ? "cursor-default opacity-40" : "cursor-pointer"
          )}
        >
          <span dir="auto" className="min-w-0 flex-1 truncate font-medium">
            {command.label}
          </span>
          {command.hint && (
            <span className="shrink-0 rounded bg-foreground/5 px-1 py-px text-[10px] font-medium text-muted-foreground/70 dark:bg-white/6">
              {command.hint}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
