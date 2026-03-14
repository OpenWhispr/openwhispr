/**
 * CloudFree SupportDropdown replacement.
 *
 * Drop-in replacement for upstream's SupportDropdown.
 * Reads all URLs and labels from branding.ts so upstream merges
 * don't affect fork-specific support links.
 *
 * After an upstream merge, just re-apply the import swap wherever
 * SupportDropdown is used:
 *
 *   - import SupportDropdown from "./ui/SupportDropdown";
 *   + import SupportDropdown from "../cloudfree/CloudFreeSupportDropdown";
 */

import React from "react";
import { Button } from "../components/ui/button";
import { HelpCircle, Bug, ExternalLink } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { cn } from "../components/lib/utils";
import logger from "../utils/logger";
import { BRANDING } from "./branding";

interface CloudFreeSupportDropdownProps {
  className?: string;
  trigger?: React.ReactNode;
}

const openExternal = async (url: string) => {
  try {
    const result = await (window as any).electronAPI?.openExternal(url);
    if (!result?.success) {
      logger.error("Failed to open URL", { error: result?.error }, "support");
    }
  } catch (error) {
    logger.error("Error opening URL", { error }, "support");
  }
};

export default function CloudFreeSupportDropdown({
  className,
  trigger,
}: CloudFreeSupportDropdownProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger || (
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "text-foreground/70 hover:text-foreground hover:bg-foreground/10",
              className
            )}
          >
            <HelpCircle size={16} />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => openExternal(BRANDING.support.bugReportUrl)}
        >
          <Bug className="mr-2 h-4 w-4" />
          {BRANDING.support.bugReportLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-[10px] text-muted-foreground/60 leading-tight">
          {BRANDING.support.attribution}
          <br />
          of{" "}
          <span
            className="underline cursor-pointer hover:text-muted-foreground"
            onClick={() => openExternal(BRANDING.upstream.repo)}
          >
            {BRANDING.upstream.name}
          </span>
          . {BRANDING.support.disclaimer}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
