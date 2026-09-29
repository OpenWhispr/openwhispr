import { useTranslation } from "react-i18next";
import { Check, ChevronDown, RefreshCw, Settings2, Sparkles } from "../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  SPLIT_BUTTON_DIVIDER_CLASS,
  SPLIT_BUTTON_GROUP_CLASS,
  SPLIT_BUTTON_SEGMENT_CLASS,
} from "../ui/splitButton";
import { cn } from "../lib/utils";
import { getActionDescription, getActionName } from "../../stores/actionStore";
import type { ActionItem } from "../../types/electron";

interface TemplatePickerProps {
  templates: ActionItem[];
  /** What the main button runs: the note's template, or the one to write it with. */
  current: ActionItem;
  /** Rewrites an existing summary rather than writing the first one. */
  regenerate: boolean;
  onRun: (template: ActionItem) => void;
  onManage: () => void;
  disabled?: boolean;
}

export default function TemplatePicker({
  templates,
  current,
  regenerate,
  onRun,
  onManage,
  disabled,
}: TemplatePickerProps) {
  const { t } = useTranslation();
  const currentName = getActionName(current, t);

  const MainIcon = regenerate ? RefreshCw : Sparkles;

  return (
    <div
      className={cn(
        SPLIT_BUTTON_GROUP_CLASS,
        "h-[30px] min-w-0",
        disabled && "pointer-events-none opacity-40"
      )}
    >
      <button
        type="button"
        onClick={() => onRun(current)}
        disabled={disabled}
        aria-label={t(
          regenerate ? "notes.templates.regenerateWith" : "notes.templates.generateWith",
          { name: currentName }
        )}
        className={cn(SPLIT_BUTTON_SEGMENT_CLASS, "min-w-0 gap-1.5 ps-2.5 pe-2")}
      >
        <MainIcon size={13} className="shrink-0 text-foreground/60" />
        <span className="max-w-36 truncate">{currentName}</span>
      </button>
      <span aria-hidden="true" className={SPLIT_BUTTON_DIVIDER_CLASS} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={t("notes.templates.select")}
            className={cn(SPLIT_BUTTON_SEGMENT_CLASS, "w-[26px] justify-center")}
          >
            <ChevronDown size={12} className="text-foreground/60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="min-w-56">
          {templates.map((template) => (
            <DropdownMenuItem
              key={template.id}
              onClick={() => onRun(template)}
              className="gap-2.5 rounded-md px-2.5 py-1.5 text-xs"
            >
              <Check
                size={12}
                className={cn("shrink-0", template.id === current.id ? "text-accent" : "invisible")}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{getActionName(template, t)}</div>
                {template.description && (
                  <div className="truncate text-xs text-muted-foreground/70">
                    {getActionDescription(template, t)}
                  </div>
                )}
              </div>
            </DropdownMenuItem>
          ))}
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
    </div>
  );
}
