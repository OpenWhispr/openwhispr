import * as React from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Globe, Lock, Building2 } from "lucide-react";
import { cn } from "../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import type { ShareVisibility } from "../../types/electron";

interface ShareVisibilityMenuProps {
  value: ShareVisibility;
  ownerDomain: string;
  showDomainOption: boolean;
  disabled?: boolean;
  onChange: (visibility: ShareVisibility) => void;
}

export default function ShareVisibilityMenu({
  value,
  ownerDomain,
  showDomainOption,
  disabled,
  onChange,
}: ShareVisibilityMenuProps) {
  const { t } = useTranslation();

  const current = renderCurrent(value, ownerDomain, t);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-xs font-medium",
            "bg-foreground/4 dark:bg-white/5 text-foreground/80",
            "hover:bg-foreground/8 dark:hover:bg-white/10",
            "active:bg-foreground/12 dark:active:bg-white/15",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "disabled:opacity-50 disabled:pointer-events-none transition-colors"
          )}
          aria-label={t("noteEditor.share.dialog.visibility.label")}
        >
          {current.icon}
          <span>{current.label}</span>
          <ChevronDown size={12} className="text-foreground/40" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4} className="min-w-[260px]">
        <VisibilityItem
          icon={<Lock size={13} className="text-foreground/50" />}
          label={t("noteEditor.share.dialog.visibility.invited")}
          active={value === "invited"}
          onSelect={() => onChange("invited")}
        />
        <VisibilityItem
          icon={<Globe size={13} className="text-foreground/50" />}
          label={t("noteEditor.share.dialog.visibility.link")}
          active={value === "link"}
          onSelect={() => onChange("link")}
        />
        {showDomainOption && (
          <VisibilityItem
            icon={<Building2 size={13} className="text-foreground/50" />}
            label={t("noteEditor.share.dialog.visibility.domain", { domain: ownerDomain })}
            active={value === "domain"}
            onSelect={() => onChange("domain")}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function renderCurrent(
  value: ShareVisibility,
  ownerDomain: string,
  t: ReturnType<typeof useTranslation>["t"]
): { icon: React.ReactNode; label: string } {
  switch (value) {
    case "link":
      return {
        icon: <Globe size={12} className="text-foreground/60" />,
        label: t("noteEditor.share.dialog.visibility.link"),
      };
    case "domain":
      return {
        icon: <Building2 size={12} className="text-foreground/60" />,
        label: t("noteEditor.share.dialog.visibility.domain", { domain: ownerDomain }),
      };
    case "private":
    case "invited":
    default:
      return {
        icon: <Lock size={12} className="text-foreground/60" />,
        label: t("noteEditor.share.dialog.visibility.invited"),
      };
  }
}

function VisibilityItem({
  icon,
  label,
  active,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem onClick={onSelect} className="text-xs gap-2 py-1.5">
      {icon}
      <span className="flex-1">{label}</span>
      {active && <Check size={12} className="text-primary" />}
    </DropdownMenuItem>
  );
}
