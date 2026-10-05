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
import { cn } from "../lib/utils";
import { getActionDescription, getActionName } from "../../stores/actionStore";
import type { ActionItem } from "../../types/electron";

interface TemplatePickerProps {
  templates: ActionItem[];
  /** The template that wrote the note's summary, or the default. */
  current: ActionItem;
  onRun: (template: ActionItem) => void;
  onManage: () => void;
  disabled?: boolean;
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
  children,
}: TemplatePickerProps) {
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="min-w-56">
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
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{getActionName(template, t)}</div>
                {template.description && (
                  <div className="truncate text-xs text-muted-foreground/70">
                    {getActionDescription(template, t)}
                  </div>
                )}
              </div>
              {isCurrent && <RefreshCw size={12} className="shrink-0 text-foreground/50" />}
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
