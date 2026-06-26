import React, { useState } from "react";
import {
  Home,
  MessageSquare,
  NotebookPen,
  BookOpen,
  Upload,
  Blocks,
  Gift,
  Settings,
  HelpCircle,
  UserCircle,
  UserPlus,
  X,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import logoIcon from "../assets/icon.png";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";
import SupportDropdown from "./ui/SupportDropdown";
import { getCachedPlatform } from "../utils/platform";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import InviteTeammateDialog from "./InviteTeammateDialog";
import CreateWorkspaceDialog from "./CreateWorkspaceDialog";
import { useWorkspace } from "../hooks/useWorkspace";
import { WORKSPACES_ENABLED } from "../lib/features";

const platform = getCachedPlatform();

const rowIconClass =
  "shrink-0 text-foreground/60 group-hover:text-foreground/75 dark:text-foreground/50 dark:group-hover:text-foreground/65 transition-colors duration-150";
const rowLabelClass =
  "text-xs text-foreground/80 group-hover:text-foreground dark:text-foreground/70 dark:group-hover:text-foreground/85 transition-colors duration-150";
const rowButtonClass =
  "group flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md text-left outline-none hover:bg-foreground/4 dark:hover:bg-white/4 focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors duration-150";
const railButtonClass =
  "group flex items-center justify-center w-full h-8 rounded-lg outline-none hover:bg-foreground/5 dark:hover:bg-white/5 focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors duration-150";
const islandClass =
  "ml-2 w-12 flex flex-col gap-0.5 rounded-2xl border border-border/60 dark:border-white/10 bg-surface-2 dark:bg-surface-2 p-1.5 shadow-[var(--shadow-card-hover-subtle)]";

export type ControlPanelView =
  | "home"
  | "chat"
  | "personal-notes"
  | "dictionary"
  | "upload"
  | "integrations";

interface ControlPanelSidebarProps {
  activeView: ControlPanelView;
  onViewChange: (view: ControlPanelView) => void;
  onOpenSettings: () => void;
  onOpenSearch?: () => void;
  onOpenReferrals?: () => void;
  onUpgrade?: () => void;
  isOverLimit?: boolean;
  userName?: string | null;
  userEmail?: string | null;
  userImage?: string | null;
  isSignedIn?: boolean;
  authLoaded?: boolean;
  isProUser?: boolean;
  usageLoaded?: boolean;
  updateAction?: React.ReactNode;
  onToggleCollapse?: () => void;
  collapsed?: boolean;
}

export default function ControlPanelSidebar({
  activeView,
  onViewChange,
  onOpenSettings,
  onOpenSearch,
  onOpenReferrals,
  onUpgrade,
  isOverLimit,
  userName,
  userEmail,
  userImage,
  isSignedIn,
  authLoaded,
  isProUser,
  usageLoaded,
  updateAction,
  onToggleCollapse,
  collapsed,
}: ControlPanelSidebarProps) {
  const { t } = useTranslation();
  const [upgradeDismissed, setUpgradeDismissed] = useState(
    () => localStorage.getItem("upgradeProDismissed") === "true"
  );
  const [inviteOpen, setInviteOpen] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const { active: activeWorkspace } = useWorkspace();

  const showLimitBanner = authLoaded && isSignedIn && !isProUser && isOverLimit;
  const showUpgradeBanner =
    !showLimitBanner &&
    authLoaded &&
    (!isSignedIn || usageLoaded !== false) &&
    !isProUser &&
    !upgradeDismissed;

  const navItems: {
    id: ControlPanelView;
    label: string;
    icon: React.ComponentType<{ size?: number; className?: string }>;
  }[] = [
    { id: "home", label: t("sidebar.home"), icon: Home },
    { id: "chat", label: t("sidebar.chat"), icon: MessageSquare },
    { id: "personal-notes", label: t("sidebar.notes"), icon: NotebookPen },
    { id: "upload", label: t("sidebar.upload"), icon: Upload },
    { id: "dictionary", label: t("sidebar.dictionary"), icon: BookOpen },
    { id: "integrations", label: t("sidebar.integrations"), icon: Blocks },
  ];

  return (
    <div
      className={cn(
        "h-full shrink-0 flex flex-col transition-all duration-300 ease-out",
        collapsed
          ? "w-16"
          : "w-48 overflow-hidden border-r border-border/15 dark:border-white/6 bg-surface-1/60 dark:bg-surface-1"
      )}
    >
      <div
        className="w-full h-10 shrink-0 flex items-center"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {onToggleCollapse && (!collapsed || platform !== "darwin") && (
          <div
            className={platform === "darwin" ? "ml-21 mt-4" : "ml-2"}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <button
              onClick={onToggleCollapse}
              aria-label={collapsed ? t("sidebar.expand") : t("sidebar.collapse")}
              className="group flex items-center justify-center h-7 w-7 rounded-md outline-none hover:bg-foreground/5 dark:hover:bg-white/5 focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors duration-150"
            >
              {collapsed ? (
                <PanelLeftOpen size={15} className={rowIconClass} />
              ) : (
                <PanelLeftClose size={15} className={rowIconClass} />
              )}
            </button>
          </div>
        )}
      </div>

      {WORKSPACES_ENABLED && isSignedIn && !collapsed && (
        <div className="px-2 pt-1 pb-1">
          <WorkspaceSwitcher userName={userName} />
        </div>
      )}

      <div className={collapsed ? cn(islandClass, "mt-1") : undefined}>
        {onOpenSearch &&
          (collapsed ? (
            <button
              onClick={onOpenSearch}
              aria-label={t("commandSearch.shortPlaceholder")}
              title={t("commandSearch.shortPlaceholder")}
              className={railButtonClass}
            >
              <Search size={15} className={rowIconClass} />
            </button>
          ) : (
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
          ))}

        <nav className={cn("flex flex-col gap-0.5", !collapsed && "px-2 pt-2 pb-2")}>
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.id;

            return (
              <button
                key={item.id}
                onClick={() => onViewChange(item.id)}
                title={collapsed ? item.label : undefined}
                className={cn(
                  "group relative flex items-center w-full h-8 outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-primary/30",
                  collapsed ? "justify-center rounded-lg" : "gap-2.5 px-2.5 rounded-md text-left",
                  isActive
                    ? "bg-primary/8 dark:bg-primary/10"
                    : collapsed
                      ? "hover:bg-foreground/5 dark:hover:bg-white/5"
                      : "hover:bg-foreground/4 dark:hover:bg-white/4 active:bg-foreground/6"
                )}
              >
                <Icon
                  size={15}
                  className={cn(
                    "shrink-0 transition-colors duration-150",
                    isActive
                      ? "text-primary"
                      : "text-foreground/60 group-hover:text-foreground/75 dark:text-foreground/55 dark:group-hover:text-foreground/70"
                  )}
                />
                {!collapsed && (
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
                )}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="flex-1" />

      {showLimitBanner && !collapsed && (
        <div className="px-2 pb-2">
          <div className="rounded-lg border border-destructive/25 bg-destructive/5 dark:bg-destructive/10 p-3">
            <div className="flex flex-col items-center text-center">
              <img src={logoIcon} alt="" className="w-7 h-7 rounded-md mb-2" />
              <p className="text-xs font-medium text-foreground mb-0.5">
                {t("sidebar.limitReached")}
              </p>
              <p className="text-[11px] leading-snug text-muted-foreground mb-2.5">
                {t("sidebar.limitReachedDescription")}
              </p>
              <button
                onClick={onUpgrade}
                className="w-full h-7 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
              >
                {t("sidebar.viewPlans")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showUpgradeBanner && !collapsed && (
        <div className="px-2 pb-2">
          <div className="relative rounded-lg border border-primary/20 bg-primary/5 dark:bg-primary/10 p-3">
            <button
              onClick={() => {
                setUpgradeDismissed(true);
                localStorage.setItem("upgradeProDismissed", "true");
              }}
              aria-label={t("common.dismiss")}
              className="absolute top-1.5 right-1.5 p-0.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
              <X size={12} />
            </button>
            <div className="flex flex-col items-center text-center pt-1">
              <img src={logoIcon} alt="" className="w-7 h-7 rounded-md mb-2" />
              <p className="text-xs font-medium text-foreground mb-0.5">
                {t("sidebar.upgradeTitle")}
              </p>
              <p className="text-[11px] leading-snug text-muted-foreground mb-2.5">
                {t("sidebar.upgradeDescription")}
              </p>
              <button
                onClick={onUpgrade}
                className="w-full h-7 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
              >
                {t("sidebar.learnMore")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={collapsed ? cn(islandClass, "mb-2") : "px-2 pb-2 space-y-0.5"}>
        {updateAction && !collapsed && (
          <div className="px-1 pb-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            {updateAction}
          </div>
        )}

        {isSignedIn && onOpenReferrals && (
          <button
            onClick={onOpenReferrals}
            aria-label={t("sidebar.referral")}
            title={collapsed ? t("sidebar.referral") : undefined}
            className={collapsed ? railButtonClass : rowButtonClass}
          >
            <Gift size={15} className={rowIconClass} />
            {!collapsed && <span className={rowLabelClass}>{t("sidebar.referral")}</span>}
          </button>
        )}

        {WORKSPACES_ENABLED && isSignedIn && (
          <button
            onClick={() => (activeWorkspace ? setInviteOpen(true) : setCreateWorkspaceOpen(true))}
            aria-label={
              activeWorkspace ? t("sidebar.inviteTeammate") : t("sidebar.createWorkspace")
            }
            title={
              collapsed
                ? activeWorkspace
                  ? t("sidebar.inviteTeammate")
                  : t("sidebar.createWorkspace")
                : undefined
            }
            className={collapsed ? railButtonClass : rowButtonClass}
          >
            <UserPlus size={15} className={rowIconClass} />
            {!collapsed && (
              <span className={rowLabelClass}>
                {activeWorkspace ? t("sidebar.inviteTeammate") : t("sidebar.createWorkspace")}
              </span>
            )}
          </button>
        )}

        <button
          onClick={onOpenSettings}
          aria-label={t("sidebar.settings")}
          title={collapsed ? t("sidebar.settings") : undefined}
          className={collapsed ? railButtonClass : rowButtonClass}
        >
          <Settings size={15} className={rowIconClass} />
          {!collapsed && <span className={rowLabelClass}>{t("sidebar.settings")}</span>}
        </button>

        <SupportDropdown
          trigger={
            <button
              aria-label={t("sidebar.support")}
              title={collapsed ? t("sidebar.support") : undefined}
              className={collapsed ? railButtonClass : rowButtonClass}
            >
              <HelpCircle size={15} className={rowIconClass} />
              {!collapsed && <span className={rowLabelClass}>{t("sidebar.support")}</span>}
            </button>
          }
        />

        {!collapsed && <div className="mx-1 h-px bg-border/10 dark:bg-white/6 my-1.5!" />}

        <div
          className={cn(
            "flex items-center rounded-md",
            collapsed ? "justify-center py-1" : "gap-2.5 px-2.5 py-1.5"
          )}
        >
          {userImage ? (
            <img src={userImage} alt="" className="w-6 h-6 rounded-full shrink-0 object-cover" />
          ) : (
            <UserCircle size={18} className="shrink-0 text-foreground/50 dark:text-foreground/45" />
          )}
          {!collapsed && (
            <div className="flex-1 min-w-0">
              {isSignedIn && (userName || userEmail) ? (
                <>
                  <p className="text-xs text-foreground/80 dark:text-foreground/80 truncate leading-tight">
                    {userName || t("sidebar.defaultUser")}
                  </p>
                  {userEmail && (
                    <p className="text-xs text-foreground/55 dark:text-foreground/55 truncate leading-tight">
                      {userEmail}
                    </p>
                  )}
                </>
              ) : authLoaded && !isSignedIn ? (
                <p className="text-xs text-foreground/45 dark:text-foreground/55">
                  {t("sidebar.notSignedIn")}
                </p>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {WORKSPACES_ENABLED && activeWorkspace && (
        <InviteTeammateDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          workspaceId={activeWorkspace.id}
          workspaceName={activeWorkspace.name}
        />
      )}
      {WORKSPACES_ENABLED && (
        <CreateWorkspaceDialog open={createWorkspaceOpen} onOpenChange={setCreateWorkspaceOpen} />
      )}
    </div>
  );
}
