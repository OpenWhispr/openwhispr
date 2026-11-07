import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Languages, RefreshCw, Settings2 } from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip } from "../ui/tooltip";
import { cn } from "../lib/utils";
import { getActionName } from "../../stores/actionStore";
import type { ActionItem } from "../../types/electron";
import { useUiLocale } from "../../hooks/useUiLocale";
import { summaryLanguageChoices, summaryLanguageLabel } from "./summaryLanguageChoices";

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
  /** Without a summary yet, running the current template creates rather than regenerates it. */
  hasSummary?: boolean;
  /** The language the next run writes in: "auto" or a language code. */
  summaryLanguage?: string;
  /** The Summary language setting, offered too when it is not a UI language. */
  summaryLanguageSetting?: string;
  onSummaryLanguageChange?: (language: string) => void;
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
  hasSummary = true,
  summaryLanguage,
  summaryLanguageSetting = "auto",
  onSummaryLanguageChange,
}: TemplatePickerProps) {
  const { t } = useTranslation();
  const locale = useUiLocale();
  const autoLanguageLabel = t("notes.templates.languageAuto");
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
              {isCurrent && hasSummary && (
                <Tooltip content={t("notes.templates.regenerate")}>
                  <RefreshCw size={12} className="shrink-0 text-foreground/50" />
                </Tooltip>
              )}
              <Check size={12} className={cn("shrink-0 text-accent", !isCurrent && "invisible")} />
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        {summaryLanguage && onSummaryLanguageChange && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-2.5 rounded-md px-2.5 py-1.5 text-xs">
              <Languages size={12} className="shrink-0 text-muted-foreground/70" />
              <span className="min-w-0 flex-1 truncate">{t("notes.templates.language")}</span>
              <span className="shrink-0 truncate text-muted-foreground/70">
                {summaryLanguageLabel(summaryLanguage, locale, autoLanguageLabel)}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-80 min-w-44 overflow-y-auto">
              {summaryLanguageChoices(summaryLanguageSetting).map((code) => (
                <DropdownMenuItem
                  key={code}
                  // Choosing a language sets the next run; the menu stays open to pick a template.
                  onSelect={(event) => {
                    event.preventDefault();
                    onSummaryLanguageChange(code);
                  }}
                  className="gap-2.5 rounded-md px-2.5 py-1.5 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {summaryLanguageLabel(code, locale, autoLanguageLabel)}
                  </span>
                  <Check
                    size={12}
                    className={cn("shrink-0 text-accent", code !== summaryLanguage && "invisible")}
                  />
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
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
