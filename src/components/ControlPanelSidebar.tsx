import React, { useState } from "react";
import { Gift, Lock, Settings, ShieldCheck, HelpCircle, X, Zap } from "./icons";
import logoIcon from "../assets/icon.png";
import { useTranslation } from "react-i18next";
import { cn } from "./lib/utils";
import SupportDropdown from "./ui/SupportDropdown";
import { Button } from "./ui/button";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import type { UpsellDecision } from "../lib/upsell";
import { useControlPanelNavItems, type ControlPanelView } from "./controlPanelNav";

export type { ControlPanelView };

const rowIconClass =
  "shrink-0 text-primary/70 group-hover:text-primary/90 dark:text-primary/65 dark:group-hover:text-primary/85 transition-colors duration-150";
const rowLabelClass =
  "text-[13px] text-primary/90 group-hover:text-primary dark:text-primary/85 dark:group-hover:text-primary transition-colors duration-150";
const rowButtonClass =
  "group flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md text-start outline-none hover:bg-text-primary/4 focus-visible:ring-1 focus-visible:ring-brand-solid/30 transition-colors duration-150";

interface ControlPanelSidebarProps {
  activeView: ControlPanelView;
  chatNeedsAttention?: boolean;
  onViewChange: (view: ControlPanelView) => void;
  onOpenSettings: () => void;
  onOpenReferrals?: () => void;
  onUpgrade?: () => void;
  isOverLimit?: boolean;
  isSignedIn?: boolean;
  upsell: UpsellDecision;
  updateAction?: React.ReactNode;
  /** False while another modal (Settings) is open, so the workspace intro waits. */
  workspaceIntroAllowed?: boolean;
}

export default function ControlPanelSidebar({
  activeView,
  chatNeedsAttention = false,
  onViewChange,
  onOpenSettings,
  onOpenReferrals,
  onUpgrade,
  isOverLimit,
  isSignedIn,
  upsell,
  updateAction,
  workspaceIntroAllowed = false,
}: ControlPanelSidebarProps) {
  const { t } = useTranslation();
  const [upgradeDismissed, setUpgradeDismissed] = useState(
    () => localStorage.getItem("upgradeProDismissed") === "true"
  );

  const showLimitBanner = upsell === "show" && Boolean(isSignedIn) && Boolean(isOverLimit);
  const showUpgradeBanner = upsell === "show" && !showLimitBanner && !upgradeDismissed;

  const navItems = useControlPanelNavItems();

  return (
    <div className="w-48 h-full shrink-0 flex flex-col bg-surface-secondary">
      <div
        className="w-full h-10 shrink-0"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      />

      <nav className="flex flex-col gap-0.5 px-2 pt-2 pb-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.id;

          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={cn(
                "group relative flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md outline-none transition-colors duration-150 text-start",
                "focus-visible:ring-1 focus-visible:ring-brand-solid/30",
                isActive
                  ? "bg-brand-solid/8 dark:bg-brand-solid/10"
                  : "hover:bg-text-primary/4 active:bg-text-primary/6"
              )}
            >
              <Icon
                size={16}
                className={cn(
                  "shrink-0 transition-colors duration-150",
                  isActive
                    ? "text-brand-solid"
                    : "text-primary/70 group-hover:text-primary/90 dark:text-primary/65 dark:group-hover:text-primary/85"
                )}
              />
              <span
                className={cn(
                  "text-[13px] transition-colors duration-150",
                  isActive
                    ? "text-primary font-medium"
                    : "text-primary/90 group-hover:text-primary dark:text-primary/85 dark:group-hover:text-primary"
                )}
              >
                {item.label}
              </span>
              {item.id === "chat" && chatNeedsAttention && (
                <span
                  role="status"
                  aria-label={t("agentWindow.waitingForAnswer")}
                  title={t("agentWindow.waitingForAnswer")}
                  className="ms-auto size-1.5 shrink-0 rounded-full bg-brand-solid"
                />
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex-1" />

      {showLimitBanner && (
        <div className="px-2 pb-2">
          <div className="rounded-lg border border-red-solid/25 bg-red-solid/5 dark:bg-red-solid/10 p-3">
            <div className="flex flex-col items-center text-center">
              <img src={logoIcon} alt="" className="w-7 h-7 rounded-md mb-2" />
              <p className="text-xs font-medium text-primary mb-0.5">{t("sidebar.limitReached")}</p>
              <p className="text-[11px] leading-snug text-secondary mb-2.5">
                {t("sidebar.limitReachedDescription")}
              </p>
              <Button size="sm" onClick={onUpgrade} className="h-7 w-full text-xs">
                {t("sidebar.viewPlans")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {showUpgradeBanner && (
        <div className="px-2 pb-2">
          <div className="relative rounded-xl border border-accent-solid/25 dark:border-accent-solid/40 bg-surface-primary bg-gradient-to-b from-accent-solid/15 via-accent-solid/5 to-transparent dark:from-accent-solid/30 dark:via-accent-solid/10 p-3">
            <button
              onClick={() => {
                setUpgradeDismissed(true);
                localStorage.setItem("upgradeProDismissed", "true");
              }}
              aria-label={t("common.dismiss")}
              className="absolute top-2 end-2 p-0.5 rounded-sm text-secondary hover:text-primary hover:bg-state-hover transition-colors"
            >
              <X size={12} />
            </button>
            <img src={logoIcon} alt="" className="w-7 h-7 rounded-md mb-2.5" />
            <p className="text-[13px] font-semibold text-primary mb-0.5">
              {t("sidebar.upgradeTitle")}
            </p>
            <p className="text-xs leading-snug text-secondary mb-2.5">
              {t("sidebar.upgradeDescription")}
            </p>
            <div className="space-y-1.5 mb-3">
              {(
                [
                  [Zap, t("sidebar.upgradeInstantSetup")],
                  [Lock, t("sidebar.upgradeZeroRetention")],
                  [ShieldCheck, t("sidebar.upgradeEnterpriseSecurity")],
                ] as const
              ).map(([Icon, label]) => (
                <div key={label} className="flex items-start gap-1.5">
                  <Icon size={12} className="shrink-0 mt-px text-primary/60" />
                  <span className="text-[11px] leading-snug text-primary/80">{label}</span>
                </div>
              ))}
            </div>
            <Button size="sm" onClick={onUpgrade} className="h-7 w-full text-xs">
              {t("sidebar.learnMore")}
            </Button>
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
            className={rowButtonClass}
          >
            <Gift size={16} className={rowIconClass} />
            <span className={rowLabelClass}>{t("sidebar.referral")}</span>
          </button>
        )}

        <button
          onClick={onOpenSettings}
          aria-label={t("sidebar.settings")}
          className={rowButtonClass}
        >
          <Settings size={16} className={rowIconClass} />
          <span className={rowLabelClass}>{t("sidebar.settings")}</span>
        </button>

        <SupportDropdown
          trigger={
            <button aria-label={t("sidebar.support")} className={rowButtonClass}>
              <HelpCircle size={16} className={rowIconClass} />
              <span className={rowLabelClass}>{t("sidebar.support")}</span>
            </button>
          }
        />

        <div className="pt-1">
          <WorkspaceSwitcher introAllowed={workspaceIntroAllowed} />
        </div>
      </div>
    </div>
  );
}
