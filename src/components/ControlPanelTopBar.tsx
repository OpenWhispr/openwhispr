import React from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, PanelLeftClose, Search } from "./icons";
import { Button } from "./ui/button";
import WindowControls from "./WindowControls";
import { cn } from "./lib/utils";
import { getCachedPlatform } from "../utils/platform";

const platform = getCachedPlatform();

// Controls inside the drag region must opt out or the click starts a window drag.
const noDragStyle = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

const toggleIconClass =
  "text-foreground/60 group-hover:text-foreground/75 dark:text-foreground/50 dark:group-hover:text-foreground/65 transition-colors duration-150 rtl:scale-x-[-1]";

interface ControlPanelTopBarProps {
  title: string;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onToggleMouseEnter?: () => void;
  onToggleMouseLeave?: () => void;
  onOpenSearch: () => void;
  /** Meeting mode or a narrow window with an open note: sidebar hidden, back button shown. */
  isSidePanelLayout: boolean;
  onExitSidePanel: () => void;
}

export default function ControlPanelTopBar({
  title,
  sidebarCollapsed,
  onToggleSidebar,
  onToggleMouseEnter,
  onToggleMouseLeave,
  onOpenSearch,
  isSidePanelLayout,
  onExitSidePanel,
}: ControlPanelTopBarProps) {
  const { t } = useTranslation();
  // With the sidebar out of the way the container's start edge sits under the
  // macOS traffic lights, so the leading controls shift past them.
  const clearTrafficLights = platform === "darwin" && (sidebarCollapsed || isSidePanelLayout);

  return (
    <header
      className={cn(
        "grid h-12 shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,340px)_minmax(0,1fr)] items-center gap-4 border-b border-border px-3 dark:border-white/10",
        // Eased with the sidebar spacer so the toggle glides instead of jumping when the
        // clearance switches; a jump would drag it back under the cursor and re-trigger peek.
        "transition-[padding] duration-300 ease-out",
        clearTrafficLights && "ltr:ps-[76px]"
      )}
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {isSidePanelLayout ? (
          <Button
            variant="outline-flat"
            size="sm"
            onClick={onExitSidePanel}
            className="h-7 gap-1 px-2.5 ps-1.5"
            data-no-window-drag=""
            style={noDragStyle}
          >
            <ChevronLeft size={14} strokeWidth={1.8} className="rtl:rotate-180" />
            {t("controlPanel.backToNotes")}
          </Button>
        ) : (
          <>
            <button
              type="button"
              onClick={onToggleSidebar}
              onMouseEnter={onToggleMouseEnter}
              onMouseLeave={onToggleMouseLeave}
              aria-label={sidebarCollapsed ? t("sidebar.expand") : t("sidebar.collapse")}
              data-no-window-drag=""
              style={noDragStyle}
              // z-40 keeps the toggle above the peeking sidebar (z-30) so the panel slides in
              // underneath it and the button stays clickable while collapsed.
              className="group relative z-40 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg outline-none transition-colors duration-150 hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-primary/30 dark:hover:bg-white/5"
            >
              <PanelLeftClose size={16} className={toggleIconClass} />
            </button>
            {/* Global h1 styles are display-sized; this is chrome, so pin it down. */}
            <h1 className="truncate text-sm! font-medium! leading-none! tracking-normal! text-foreground">
              {title}
            </h1>
          </>
        )}
      </div>

      {!isSidePanelLayout && (
        <button
          type="button"
          onClick={onOpenSearch}
          data-no-window-drag=""
          style={noDragStyle}
          className="flex h-8 w-full items-center gap-2.5 rounded-full bg-foreground/4 px-4 text-start outline-none transition-colors duration-150 hover:bg-foreground/6 focus-visible:ring-1 focus-visible:ring-primary/30 dark:bg-white/5 dark:hover:bg-white/8"
        >
          <Search size={14} className="shrink-0 text-muted-foreground/70" />
          <span className="flex-1 truncate text-[13px] text-muted-foreground/70">
            {t("commandSearch.placeholder")}
          </span>
          <kbd
            dir="ltr"
            className="shrink-0 rounded-full bg-foreground/6 px-1.5 py-px font-sans text-[10px] font-medium text-muted-foreground/70 dark:bg-white/8"
          >
            {platform === "darwin" ? "⌘ + K" : "Ctrl + K"}
          </kbd>
        </button>
      )}

      <div className="col-start-3 flex items-center justify-self-end">
        {platform !== "darwin" && (
          <div data-no-window-drag="" style={noDragStyle}>
            <WindowControls />
          </div>
        )}
      </div>
    </header>
  );
}
