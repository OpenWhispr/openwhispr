import React from "react";
import { ChevronRight, ChevronDown } from "lucide-react";
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
  icon?: React.ReactNode;
  trailing?: "control" | "chevron" | "summary";
  summaryValue?: string;
  onNavigate?: () => void;
  children?: React.ReactNode;
  className?: string;
}

export const SettingsRow: React.FC<SettingsRowProps> = ({
  label,
  description,
  icon,
  trailing = "control",
  summaryValue,
  onNavigate,
  children,
  className = "",
}) => {
  const { isCompact } = useSettingsLayout();

  const content = (
    <>
      {icon && (
        <div className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 bg-muted/60 dark:bg-surface-raised text-muted-foreground">
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-foreground">{label}</p>
        {description && (
          <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">{description}</p>
        )}
      </div>
      <div className={isCompact ? "" : "shrink-0"}>
        {trailing === "chevron" && (
          <ChevronRight className="w-4 h-4 text-muted-foreground/60" />
        )}
        {trailing === "summary" && (
          <div className="flex items-center gap-1 text-muted-foreground">
            {summaryValue && <span className="text-xs">{summaryValue}</span>}
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/60" />
          </div>
        )}
        {trailing === "control" && children}
      </div>
    </>
  );

  const rowClassName = `flex ${
    isCompact ? "flex-col items-start gap-2" : "items-center justify-between gap-4"
  } ${className}`;

  if (trailing !== "control" && onNavigate) {
    return (
      <button type="button" onClick={onNavigate} className={`w-full text-left ${rowClassName}`}>
        {content}
      </button>
    );
  }

  return <div className={rowClassName}>{content}</div>;
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
      className={`rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card dark:bg-surface-2 divide-y divide-border/30 dark:divide-border-subtle/50 ${className}`}
    >
      {children}
    </div>
  );
}

export function SettingsPanelRow({
  children,
  className = "",
  interactive = false,
}: {
  children: React.ReactNode;
  className?: string;
  interactive?: boolean;
}) {
  const { isCompact } = useSettingsLayout();

  return (
    <div
      className={`${isCompact ? "px-3 py-2.5" : "px-4 py-3"} ${
        interactive ? "hover:bg-foreground/3 dark:hover:bg-white/3 cursor-pointer transition-colors" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionHeader({
  title,
  description,
  note,
}: {
  title: string;
  description?: string;
  note?: string | false;
}) {
  return (
    <div className="mb-3">
      <h3 className="text-xs font-semibold text-foreground tracking-tight">{title}</h3>
      {description && (
        <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">{description}</p>
      )}
      {note && <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">{note}</p>}
    </div>
  );
}

export interface InferenceModeOption {
  id: InferenceMode;
  disabled?: boolean;
  badge?: string;
  activeLabel?: string;
  label: string;
  description: string;
  icon: React.ReactNode;
}

interface RadioListItemProps {
  icon?: React.ReactNode;
  label: string;
  description?: string;
  badge?: string;
  activeLabel?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function RadioListItem({
  icon,
  label,
  description,
  badge,
  activeLabel,
  selected,
  disabled = false,
  onSelect,
}: RadioListItemProps) {
  return (
    <SettingsPanelRow
      className={`transition-colors ${disabled ? "" : "hover:bg-foreground/3 dark:hover:bg-white/3"}`}
    >
      <button
        onClick={onSelect}
        disabled={disabled}
        className={`w-full flex items-center gap-3 text-left cursor-pointer group ${
          disabled ? "opacity-60" : ""
        }`}
      >
        {icon && (
          <div
            className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors ${
              selected
                ? "bg-primary/10 dark:bg-primary/15"
                : "bg-muted/60 dark:bg-surface-raised group-hover:bg-muted dark:group-hover:bg-surface-3"
            }`}
          >
            <div className={`transition-colors ${selected ? "text-primary" : "text-muted-foreground"}`}>
              {icon}
            </div>
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground">{label}</span>
            {selected && !disabled && activeLabel && (
              <span className="text-xs font-medium text-primary bg-primary/10 dark:bg-primary/15 px-1.5 py-px rounded-sm">
                {activeLabel}
              </span>
            )}
            {disabled && badge && (
              <span className="text-xs font-medium text-muted-foreground bg-muted/80 dark:bg-surface-3 px-1.5 py-px rounded-sm">
                {badge}
              </span>
            )}
          </div>
          {description && (
            <p className="text-xs text-muted-foreground/80 mt-0.5">{description}</p>
          )}
        </div>
        <div
          className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${
            selected ? "border-primary bg-primary" : "border-border-hover dark:border-border-subtle"
          }`}
        >
          {selected && (
            <div className="w-full h-full flex items-center justify-center">
              <div className="w-1.5 h-1.5 rounded-full bg-primary-foreground" />
            </div>
          )}
        </div>
      </button>
    </SettingsPanelRow>
  );
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
    <SettingsPanel className="overflow-hidden">
      {modes.map((mode) => (
        <RadioListItem
          key={mode.id}
          icon={mode.icon}
          label={mode.label}
          description={mode.description}
          badge={mode.badge}
          activeLabel={mode.activeLabel ?? t("common.active")}
          selected={activeMode === mode.id}
          disabled={mode.disabled}
          onSelect={() => onSelect(mode.id)}
        />
      ))}
    </SettingsPanel>
  );
}
