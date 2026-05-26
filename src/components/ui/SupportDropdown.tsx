import React from "react";
import { Button } from "./button";
import { HelpCircle } from "lucide-react";
import { cn } from "../lib/utils";
import logger from "../../utils/logger";

interface SupportDropdownProps {
  className?: string;
  trigger?: React.ReactElement<{ onClick?: (e: React.MouseEvent) => void }>;
}

const HELP_URL = "https://help.corti.app";

const openHelp = async () => {
  try {
    const result = await window.electronAPI?.openExternal(HELP_URL);
    if (!result?.success) {
      logger.error("Failed to open URL", { error: result?.error }, "support");
    }
  } catch (error) {
    logger.error("Error opening URL", { error }, "support");
  }
};

export default function SupportDropdown({ className, trigger }: SupportDropdownProps) {
  if (trigger) {
    return React.cloneElement(trigger, { onClick: openHelp });
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={openHelp}
      className={cn(
        "text-foreground/70 hover:text-foreground hover:bg-foreground/10",
        className
      )}
    >
      <HelpCircle size={16} />
    </Button>
  );
}
