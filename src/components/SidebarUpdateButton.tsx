import type React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "./icons";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  SPLIT_BUTTON_DIVIDER_CLASS,
  SPLIT_BUTTON_GROUP_CLASS,
  SPLIT_BUTTON_SEGMENT_CLASS,
} from "./ui/splitButton";
import { cn } from "./lib/utils";

interface SidebarUpdateButtonProps {
  downloaded: boolean;
  disabled: boolean;
  onClick: () => void;
  /** Given while a release can still be skipped; the chevron's menu offers it. */
  onSkipVersion?: () => void;
  children: React.ReactNode;
}

/** The sidebar's update button: download, progress or install, plus Skip this version. */
export default function SidebarUpdateButton({
  downloaded,
  disabled,
  onClick,
  onSkipVersion,
  children,
}: SidebarUpdateButtonProps) {
  const { t } = useTranslation();

  if (!onSkipVersion) {
    return (
      <Button
        variant={downloaded ? "default" : "outline"}
        size="sm"
        onClick={onClick}
        disabled={disabled}
        className="gap-1.5 text-xs w-full h-7"
      >
        {children}
      </Button>
    );
  }

  return (
    <div className={cn(SPLIT_BUTTON_GROUP_CLASS, "h-7 w-full")}>
      <button
        type="button"
        onClick={onClick}
        className={cn(SPLIT_BUTTON_SEGMENT_CLASS, "min-w-0 flex-1 justify-center gap-1.5 ps-3")}
      >
        {children}
      </button>
      <span aria-hidden="true" className={SPLIT_BUTTON_DIVIDER_CLASS} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("controlPanel.update.moreActions")}
            className={cn(SPLIT_BUTTON_SEGMENT_CLASS, "w-7 justify-center pe-0.5")}
          >
            <ChevronDown size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6}>
          <DropdownMenuItem onSelect={onSkipVersion}>
            {t("controlPanel.update.skipVersion")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
