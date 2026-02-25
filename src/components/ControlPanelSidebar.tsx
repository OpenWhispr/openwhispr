import React, { useState } from "react";
import {
  Home,
  NotebookPen,
  BookOpen,
  Upload,
  Gift,
  Settings,
  HelpCircle,
  UserCircle,
  X,
} from "lucide-react";
import logoIcon from "../assets/icon.png";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";
import SupportDropdown from "./ui/SupportDropdown";

export type ControlPanelView = "home" | "personal-notes" | "dictionary" | "upload";

interface ControlPanelSidebarProps {
  activeView: ControlPanelView;
  onViewChange: (view: ControlPanelView) => void;
  onOpenSettings: () => void;
  onOpenReferrals?: () => void;
  onUpgrade?: () => void;
  onUpgradeCheckout?: () => void;
  isOverLimit?: boolean;
  userName?: string | null;
  userEmail?: string | null;
  userImage?: string | null;
  isSignedIn?: boolean;
  authLoaded?: boolean;
  isProUser?: boolean;
  usageLoaded?: boolean;
  updateAction?: React.ReactNode;
}

export default function ControlPanelSidebar({
  activeView,
  onViewChange,
  onOpenSettings,
  onOpenReferrals,
  onUpgrade,
  onUpgradeCheckout,
  isOverLimit,
  userName,
  userEmail,
  userImage,
  isSignedIn,
  authLoaded,
  isProUser,
  usageLoaded,
  updateAction,
}: ControlPanelSidebarProps) {
  const { t } = useTranslation();
  const [upgradeDismissed, setUpgradeDismissed] = useState(
    () => localStorage.getItem("upgradeProDismissed") === "true"
  );

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
    { id: "personal-notes", label: t("sidebar.notes"), icon: NotebookPen },
    { id: "upload", label: t("sidebar.upload"), icon: Upload },
    { id: "dictionary", label: t("sidebar.dictionary"), icon: BookOpen },
  ];

  return (
    <div className="w-48 shrink-0 border-r border-border/15 dark:border-white/6 flex flex-col bg-surface-1/60 dark:bg-surface-1">
      <div
        className="w-full h-10 shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      <nav className="flex flex-col gap-0.5 px-2 pt-4 pb-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.id;

          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={cn(
                "group relative flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md outline-none transition-colors duration-150 text-left",
                "focus-visible:ring-1 focus-visible:ring-primary/30",
                isActive
                  ? "bg-primary/8 dark:bg-primary/10"
                  : "hover:bg-foreground/4 dark:hover:bg-white/4 active:bg-foreground/6"
              )}
            >
              {isActive && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-3.5 rounded-r-full bg-primary" />
              )}
              <Icon
                size={15}
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

      {showLimitBanner && (
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
                onClick={onUpgradeCheckout}
                className="w-full h-7 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
              >
                {t("sidebar.upgradeToPro")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showUpgradeBanner && (
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

      <div className="px-2 pb-2 space-y-0.5">
        {updateAction && (
          <div className="px-1 pb-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            {updateAction}
          </div>
        )}

        {isSignedIn && onOpenReferrals && (
          <button
            onClick={onOpenReferrals}
            aria-label={t("sidebar.referral")}
            className="group flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md text-left outline-none hover:bg-foreground/4 dark:hover:bg-white/4 focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors duration-150"
          >
            <Gift
              size={15}
              className="shrink-0 text-foreground/60 group-hover:text-foreground/75 dark:text-foreground/50 dark:group-hover:text-foreground/65 transition-colors duration-150"
            />
            <span className="text-xs text-foreground/80 group-hover:text-foreground dark:text-foreground/70 dark:group-hover:text-foreground/85 transition-colors duration-150">
              {t("sidebar.referral")}
            </span>
          </button>
        )}

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

        <div className="mx-1 h-px bg-border/10 dark:bg-white/6 my-1.5!" />

        <div className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-md">
          {userImage ? (
            <img src={userImage} alt="" className="w-6 h-6 rounded-full shrink-0 object-cover" />
          ) : (
            <UserCircle size={18} className="shrink-0 text-foreground/50 dark:text-foreground/45" />
          )}
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
        </div>
      </div>
    </div>
  );
}
