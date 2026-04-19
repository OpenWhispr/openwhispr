import React from "react";
import { useTranslation } from "react-i18next";
import { useSettingsLayout } from "./useSettingsLayout";
import type { InferenceMode } from "../../types/electron";

interface SettingsSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  description,
  children,
  className = "",
}) => {
  return (
    <div className={`space-y-3 ${className}`}>
      <div>
        <h3 className="text-xs font-semibold text-foreground tracking-tight">{title}</h3>
        {description && (
          <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
};

interface SettingsGroupProps {
  title?: string;
  children: React.ReactNode;
  variant?: "default" | "highlighted";
  className?: string;
}

export const SettingsGroup: React.FC<SettingsGroupProps> = ({
  title,
  children,
  variant = "default",
  className = "",
}) => {
  const baseClasses = "space-y-3 p-3 rounded-lg border";
  const variantClasses = {
    default: "bg-card/50 dark:bg-surface-2/50 border-border/50 dark:border-border-subtle",
    highlighted: "bg-primary/5 dark:bg-primary/10 border-primary/20 dark:border-primary/30",
  };

  return (
    <div className={`${baseClasses} ${variantClasses[variant]} ${className}`}>
      {title && <h4 className="text-xs font-medium text-foreground">{title}</h4>}
      {children}
    </div>
  );
};

interface SettingsRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export const SettingsRow: React.FC<SettingsRowProps> = ({
  label,
  description,
  children,
  className = "",
}) => {
  const { isCompact } = useSettingsLayout();

  return (
    <div
      className={`flex ${
        isCompact ? "flex-col items-start gap-2" : "items-center justify-between gap-4"
      } ${className}`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">{label}</p>
        {description && (
          <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">{description}</p>
        )}
      </div>
      <div className={isCompact ? "" : "shrink-0"}>{children}</div>
    </div>
  );
};

export function SettingsPanel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 backdrop-blur-sm divide-y divide-border/30 dark:divide-border-subtle/50 ${className}`}
    >
      {children}
    </div>
  );
}

export function SettingsPanelRow({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { isCompact } = useSettingsLayout();

  return (
    <div className={`${isCompact ? "px-3 py-2.5" : "px-4 py-3"} ${className}`}>{children}</div>
  );
}

export function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-xs font-semibold text-foreground tracking-tight">{title}</h3>
      {description && (
        <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">{description}</p>
      )}
    </div>
  );
}

export interface InferenceModeOption {
  id: InferenceMode;
  disabled?: boolean;
  badge?: string;
  label: string;
  description: string;
  icon: React.ReactNode;
}

export function InferenceModeSelector({
  modes,
  activeMode,
  onSelect,
}: {
  modes: InferenceModeOption[];
  activeMode: InferenceMode;
  onSelect: (mode: InferenceMode) => void;
}) {
  const { t } = useTranslation();

  return (
    <SettingsPanel>
      {modes.map((mode) => {
        const isActive = activeMode === mode.id;
        const isDisabled = !!mode.disabled;
        return (
          <SettingsPanelRow key={mode.id}>
            <button
              onClick={() => onSelect(mode.id)}
              className={`w-full flex items-center gap-3 text-left cursor-pointer group ${
                isDisabled ? "opacity-60" : ""
              }`}
            >
              <div
                className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                  isActive
                    ? "bg-primary/10 dark:bg-primary/15"
                    : "bg-muted/60 dark:bg-surface-raised group-hover:bg-muted dark:group-hover:bg-surface-3"
                }`}
              >
                <div
                  className={`transition-colors ${isActive ? "text-primary" : "text-muted-foreground"}`}
                >
                  {mode.icon}
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-foreground">{mode.label}</span>
                  {isActive && !isDisabled && (
                    <span className="text-xs font-medium text-primary bg-primary/10 dark:bg-primary/15 px-1.5 py-px rounded-sm">
                      {t("common.active")}
                    </span>
                  )}
                  {isDisabled && mode.badge && (
                    <span className="text-xs font-medium text-muted-foreground bg-muted/80 dark:bg-surface-3 px-1.5 py-px rounded-sm">
                      {mode.badge}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground/80 mt-0.5">{mode.description}</p>
              </div>
              <div
                className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${
                  isActive
                    ? "border-primary bg-primary"
                    : "border-border-hover dark:border-border-subtle"
                }`}
              >
                {isActive && (
                  <div className="w-full h-full flex items-center justify-center">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary-foreground" />
                  </div>
                )}
              </div>
            </button>
          </SettingsPanelRow>
        );
      })}
    </SettingsPanel>
  );
}
