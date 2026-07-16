import React, { useState, useEffect } from "react";
import {
  Home,
  NotebookPen,
  BookOpen,
  Upload,
  Settings,
  HelpCircle,
  Search,
  Wand2,
  Braces,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";
import SupportDropdown from "./ui/SupportDropdown";
import { getCachedPlatform } from "../utils/platform";
import logo from "../assets/logo.svg";

const platform = getCachedPlatform();

export type ControlPanelView =
  "home" | "personal-notes" | "dictionary" | "snippets" | "upload" | "transform";

interface ControlPanelSidebarProps {
  activeView: ControlPanelView;
  onViewChange: (view: ControlPanelView) => void;
  onOpenSettings: () => void;
  onOpenSearch?: () => void;
  updateAction?: React.ReactNode;
}

export default function ControlPanelSidebar({
  activeView,
  onViewChange,
  onOpenSettings,
  onOpenSearch,
  updateAction,
}: ControlPanelSidebarProps) {
  const { t } = useTranslation();
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      ?.getAppVersion?.()
      .then((result) => {
        if (!cancelled && result?.version) setAppVersion(result.version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const navItems: {
    id: ControlPanelView;
    label: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
  }[] = [
    { id: "home", label: t("sidebar.home"), icon: Home },
    { id: "personal-notes", label: t("sidebar.notes"), icon: NotebookPen },
    { id: "upload", label: t("sidebar.upload"), icon: Upload },
    { id: "dictionary", label: t("sidebar.dictionary"), icon: BookOpen },
    { id: "snippets", label: t("sidebar.snippets"), icon: Braces },
    { id: "transform", label: t("sidebar.transform"), icon: Wand2 },
  ];

  return (
    <div className="w-48 h-full shrink-0 border-r border-border/15 dark:border-white/6 flex flex-col bg-surface-1/60 dark:bg-surface-1">
      <div
        className="w-full h-10 shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      <div
        className="flex items-center gap-2.5 px-3 pt-1 pb-3"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <img src={logo} alt="EktosWhispr" className="w-8 h-8 rounded-full shrink-0" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground truncate">EktosWhispr</p>
          {appVersion && (
            <p className="text-[11px] text-muted-foreground/70 truncate">v{appVersion}</p>
          )}
        </div>
      </div>

      {onOpenSearch && (
        <div className="px-2 pt-2 pb-1">
          <button
            onClick={onOpenSearch}
            className="group flex items-center w-full h-7 px-2.5 rounded-md border border-border/70 dark:border-white/25 bg-transparent hover:bg-foreground/5 dark:hover:bg-white/5 transition-colors gap-2 outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
          >
            <Search size={11} className="text-muted-foreground/50 shrink-0" />
            <span className="flex-1 text-[11px] text-left text-muted-foreground/50">
              {t("commandSearch.shortPlaceholder")}
            </span>
            <div className="flex items-center gap-0.5 shrink-0">
              <kbd className="text-[10px] px-1 py-px rounded border border-border/30 dark:border-white/8 bg-muted/40 text-muted-foreground/40 font-mono leading-tight">
                {platform === "darwin" ? "⌘" : "Ctrl"}
              </kbd>
              <kbd className="text-[10px] px-1 py-px rounded border border-border/30 dark:border-white/8 bg-muted/40 text-muted-foreground/40 font-mono leading-tight">
                K
              </kbd>
            </div>
          </button>
        </div>
      )}

      <nav className="flex flex-col gap-0.5 px-2 pt-2 pb-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.id;

          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={cn(
                "group relative flex items-center gap-2.5 w-full h-9 px-3 rounded-lg outline-none transition-colors duration-150 text-left",
                "focus-visible:ring-1 focus-visible:ring-primary/30",
                isActive
                  ? "bg-foreground/6 dark:bg-white/8"
                  : "hover:bg-foreground/4 dark:hover:bg-white/4 active:bg-foreground/6"
              )}
            >
              <Icon
                size={16}
                className={cn(
                  "shrink-0 transition-colors duration-150",
                  isActive
                    ? "text-primary"
                    : "text-foreground/60 group-hover:text-foreground/75 dark:text-foreground/55 dark:group-hover:text-foreground/70"
                )}
              />
              <span
                className={cn(
                  "text-xs transition-colors duration-150",
                  isActive
                    ? "text-foreground font-medium"
                    : "text-foreground/80 group-hover:text-foreground dark:text-foreground/75 dark:group-hover:text-foreground/90"
                )}
              >
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="flex-1" />

      <div className="px-2 pb-2 space-y-0.5">
        {updateAction && (
          <div className="px-1 pb-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            {updateAction}
          </div>
        )}

        <SupportDropdown
          trigger={
            <button
              aria-label={t("sidebar.support")}
              className="group flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md text-left outline-none hover:bg-foreground/4 dark:hover:bg-white/4 focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors duration-150"
            >
              <HelpCircle
                size={15}
                className="shrink-0 text-foreground/60 group-hover:text-foreground/75 dark:text-foreground/50 dark:group-hover:text-foreground/65 transition-colors duration-150"
              />
              <span className="text-xs text-foreground/80 group-hover:text-foreground dark:text-foreground/70 dark:group-hover:text-foreground/85 transition-colors duration-150">
                {t("sidebar.support")}
              </span>
            </button>
          }
        />

        <button
          onClick={onOpenSettings}
          aria-label={t("sidebar.settings")}
          className="group flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md text-left outline-none hover:bg-foreground/4 dark:hover:bg-white/4 focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors duration-150"
        >
          <Settings
            size={15}
            className="shrink-0 text-foreground/60 group-hover:text-foreground/75 dark:text-foreground/50 dark:group-hover:text-foreground/65 transition-colors duration-150"
          />
          <span className="text-xs text-foreground/80 group-hover:text-foreground dark:text-foreground/70 dark:group-hover:text-foreground/85 transition-colors duration-150">
            {t("sidebar.settings")}
          </span>
        </button>
      </div>

    </div>
  );
}
