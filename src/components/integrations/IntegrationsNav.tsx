import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen } from "../icons";
import { Badge } from "../ui/badge";
import { cn } from "../lib/utils";
import {
  INTEGRATIONS_SECTION_GROUPS,
  INTEGRATIONS_SECTION_ICONS,
  type IntegrationsSection,
  type SectionMeta,
} from "./integrationsSections";

export const INTEGRATIONS_DOCS_URL = "https://docs.openwhispr.com";

interface IntegrationsNavProps {
  active: IntegrationsSection;
  meta: Record<IntegrationsSection, SectionMeta | null>;
  onSelect: (section: IntegrationsSection) => void;
  className?: string;
}

function SectionMetaTag({ meta }: { meta: SectionMeta | null }): ReactElement | null {
  const { t } = useTranslation();
  if (!meta) return null;
  if (meta.kind === "count") {
    return (
      <span className="ms-auto flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
        {meta.value}
      </span>
    );
  }
  return (
    <Badge variant="outline" className="ms-auto text-[10px] px-1.5 py-0 font-normal">
      {meta.badge === "pro" ? t("integrations.plan.pro") : t("integrations.cli.local.freeBadge")}
    </Badge>
  );
}

export function IntegrationsNav({
  active,
  meta,
  onSelect,
  className,
}: IntegrationsNavProps): ReactElement {
  const { t } = useTranslation();

  return (
    <nav
      aria-label={t("integrations.nav.label")}
      className={cn(
        "w-54 shrink-0 flex flex-col gap-4 overflow-y-auto border-e border-border/70 dark:border-white/8 px-2 pt-3 pb-3",
        className
      )}
    >
      {INTEGRATIONS_SECTION_GROUPS.map((group) => (
        <div key={group.id}>
          <div className="px-2.5 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            {t(`integrations.nav.groups.${group.id}`)}
          </div>
          <div className="flex flex-col gap-0.5">
            {group.sections.map((section) => {
              const Icon = INTEGRATIONS_SECTION_ICONS[section];
              const isActive = section === active;
              return (
                <button
                  key={section}
                  type="button"
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => onSelect(section)}
                  className={cn(
                    "group flex items-center gap-2.5 w-full h-8 px-2.5 rounded-md outline-none transition-colors duration-150 text-start",
                    "focus-visible:ring-1 focus-visible:ring-primary/30",
                    isActive
                      ? "bg-primary/8 dark:bg-primary/10"
                      : "hover:bg-foreground/4 dark:hover:bg-white/4 active:bg-foreground/6"
                  )}
                >
                  <Icon
                    size={15}
                    className={cn(
                      "shrink-0 transition-colors duration-150",
                      isActive
                        ? "text-primary"
                        : "text-foreground/60 group-hover:text-foreground/85 dark:text-foreground/60"
                    )}
                  />
                  <span
                    className={cn(
                      "truncate text-[12.5px] transition-colors duration-150",
                      isActive
                        ? "text-foreground font-medium"
                        : "text-foreground/85 group-hover:text-foreground"
                    )}
                  >
                    {t(`integrations.nav.sections.${section}`)}
                  </span>
                  <SectionMetaTag meta={meta[section]} />
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="flex-1" />
      <button
        type="button"
        onClick={() => window.electronAPI?.openExternal?.(INTEGRATIONS_DOCS_URL)}
        className="flex items-center gap-2 h-7 px-2.5 rounded-md text-xs text-muted-foreground outline-none transition-colors hover:text-foreground hover:bg-foreground/4 dark:hover:bg-white/4 focus-visible:ring-1 focus-visible:ring-primary/30"
      >
        <BookOpen size={14} className="shrink-0" />
        {t("integrations.nav.docs")}
      </button>
    </nav>
  );
}
