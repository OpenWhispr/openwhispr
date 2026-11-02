import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, CornerDownLeft } from "../icons";
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

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-foreground/[0.07] px-1 font-sans text-[10px] font-medium text-foreground/65 shadow-[inset_0_-1px_0_rgb(0_0_0/0.08)] dark:bg-white/[0.08]">
      {children}
    </kbd>
  );
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
  const { t } = useTranslation();
  const activeRef = useRef<HTMLButtonElement>(null);

  // Arrow keys and a narrowing filter can leave the highlighted row out of view.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, commands]);

  return (
    <div
      // Keep focus in the composer, wherever the press lands.
      onMouseDown={(event) => event.preventDefault()}
      // Rows line up with the draft's text.
      className="flex min-h-0 flex-1 flex-col px-1.5 pt-2.5 animate-[fade-in-up_0.2s_ease-out] motion-reduce:animate-none"
    >
      {/* The keys the composer answers to while the menu is open. */}
      <div
        aria-hidden="true"
        className="flex shrink-0 items-center gap-4 px-2.5 pb-2 text-[11px] text-muted-foreground/80"
      >
        <span className="flex items-center gap-1.5">
          <Key>
            <ChevronUp size={10} />
          </Key>
          <Key>
            <ChevronDown size={10} />
          </Key>
          {t("agentMode.input.slashNavigate")}
        </span>
        <span className="flex items-center gap-1.5">
          <Key>
            <CornerDownLeft size={10} />
          </Key>
          {t("agentMode.input.slashSelect")}
        </span>
        <span className="ms-auto flex items-center gap-1.5">
          <Key>esc</Key>
          {t("agentMode.input.slashClose")}
        </span>
      </div>
      <div
        id={id}
        role="listbox"
        aria-label={label}
        // A scrolling list is otherwise a tab stop, and Shift+Tab into it would close it.
        tabIndex={-1}
        // The end padding leaves room for the highlighted row's nudge.
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pe-1 pb-2"
      >
        {commands.map((command, index) => {
          const isActive = index === activeIndex;
          return (
            <button
              key={command.id}
              ref={isActive ? activeRef : undefined}
              id={slashOptionId(id, index)}
              type="button"
              role="option"
              aria-selected={isActive}
              aria-disabled={command.disabled}
              tabIndex={-1}
              onClick={() => onRun(command)}
              // Move, not enter: rows sliding under a resting pointer as the list filters or
              // scrolls mustn't change which command Enter runs.
              onMouseMove={() => onActiveIndexChange(index)}
              style={{ animationDelay: `${Math.min(index, 8) * 25}ms` }}
              className={cn(
                "flex w-full shrink-0 items-center gap-3 rounded-xl px-2.5 py-2 text-start text-xs",
                "transition-[background-color,color,translate] duration-200 ease-out",
                "animate-[fade-in-up_0.3s_cubic-bezier(0.22,1,0.36,1)_backwards] motion-reduce:animate-none",
                isActive
                  ? "translate-x-1 bg-foreground/[0.07] text-foreground rtl:-translate-x-1 dark:bg-white/[0.08]"
                  : "text-foreground/70",
                command.disabled ? "cursor-default opacity-40" : "cursor-pointer"
              )}
            >
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-200",
                  isActive ? "bg-foreground/10 dark:bg-white/[0.12]" : "bg-foreground/[0.06]"
                )}
              >
                <command.icon size={15} className="text-primary" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span dir="auto" className="truncate text-[13px] font-medium">
                  {command.label}
                </span>
                {command.description && (
                  <span dir="auto" className="truncate text-muted-foreground/70">
                    {command.description}
                  </span>
                )}
              </span>
              {command.hint && (
                <span className="shrink-0 rounded bg-foreground/5 px-1 py-px text-[10px] font-medium text-muted-foreground/70 dark:bg-white/6">
                  {command.hint}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
