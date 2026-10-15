import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, RefreshCw, Settings2 } from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip } from "../ui/tooltip";
import { cn } from "../lib/utils";
import { getActionName } from "../../stores/actionStore";
import type { ActionItem } from "../../types/electron";

interface TemplatePickerProps {
  templates: ActionItem[];
  /** The template that wrote the note's summary, or the default. */
  current: ActionItem;
  onRun: (template: ActionItem) => void;
  onManage: () => void;
  disabled?: boolean;
  /** The menu opens under this element's start edge instead of the trigger's. */
  alignTo: React.RefObject<HTMLElement | null>;
  /** The trigger, rendered as is. */
  children: React.ReactNode;
}

/** The templates that write a note's AI summary, opened from the AI Summary tab. */
export default function TemplatePicker({
  templates,
  current,
  onRun,
  onManage,
  disabled,
  alignTo,
  children,
}: TemplatePickerProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [alignOffset, setAlignOffset] = useState(0);

  // Radix only aligns a menu with its trigger, so shift it by the distance between the two
  // start edges (Radix mirrors the offset in right-to-left layouts).
  const handleOpenChange = (open: boolean) => {
    const anchor = alignTo.current?.getBoundingClientRect();
    const trigger = triggerRef.current;
    if (!open || !anchor || !trigger) return;
    const bounds = trigger.getBoundingClientRect();
    setAlignOffset(
      getComputedStyle(trigger).direction === "rtl"
        ? bounds.right - anchor.right
        : anchor.left - bounds.left
    );
  };

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger ref={triggerRef} asChild disabled={disabled}>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        alignOffset={alignOffset}
        sideOffset={6}
        className="min-w-56"
      >
        <DropdownMenuLabel className="px-2.5 py-1 text-[11px] font-medium text-muted-foreground/70">
          {t("notes.templates.tab")}
        </DropdownMenuLabel>
        {templates.map((template) => {
          const isCurrent = template.id === current.id;
          return (
            <DropdownMenuItem
              key={template.id}
              onClick={() => onRun(template)}
              className="gap-2.5 rounded-md px-2.5 py-1.5 text-xs"
            >
              <span dir="auto" className="min-w-0 flex-1 truncate font-medium">
                {getActionName(template, t)}
              </span>
              {isCurrent && (
                <Tooltip content={t("notes.templates.regenerate")}>
                  <RefreshCw size={12} className="shrink-0 text-foreground/50" />
                </Tooltip>
              )}
              <Check size={12} className={cn("shrink-0 text-accent", !isCurrent && "invisible")} />
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={onManage}
          className="gap-2.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground/70"
        >
          <Settings2 size={12} />
          {t("notes.templates.manage")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
