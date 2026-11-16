import type { ReactElement, Ref } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Plus } from "../icons";
import { Button } from "../ui/button";
import { CARD_SURFACE_CLASS } from "../ui/surfaces";
import { cn } from "../lib/utils";
import { useSkillsStore } from "../../stores/skillsStore";
import type { SkillSummary } from "../../types/skills";
import { SkillIcon } from "./SkillIcon";

interface SkillTileProps {
  /** Plays the icon whenever this skill's play count goes up. */
  name?: string;
  /** Tinted when the skill is on. */
  on: boolean;
  className?: string;
  iconSize?: number;
}

export function SkillTile({
  name,
  on,
  className = "w-9 h-9 rounded-lg",
  iconSize = 16,
}: SkillTileProps): ReactElement {
  const playKey = useSkillsStore((state) => (name ? (state.iconPlays[name] ?? 0) : 0));
  return (
    <div
      className={cn(
        "flex items-center justify-center shrink-0 transition-colors",
        on
          ? "bg-brand-solid/5 dark:bg-brand-solid/10 text-brand-solid/80"
          : "bg-surface-secondary/60 dark:bg-surface-tertiary text-secondary",
        className
      )}
    >
      <SkillIcon size={iconSize} playKey={playKey} />
    </div>
  );
}

/** Marks a skill that can't be used until it's fixed, wherever the skill is listed. */
export function NeedsFixLabel(): ReactElement {
  const { t } = useTranslation();
  return (
    <span className="flex shrink-0 items-center gap-1 text-[11px] text-amber">
      <AlertTriangle size={12} />
      {t("skills.pane.needsFix")}
    </span>
  );
}

interface InstalledSkillCardProps {
  skill: SkillSummary;
  onOpen: () => void;
  ref?: Ref<HTMLButtonElement>;
}

export function InstalledSkillCard({ skill, onOpen, ref }: InstalledSkillCardProps): ReactElement {
  const { t } = useTranslation();
  const state = !skill.valid ? "stateNeedsFix" : skill.enabled ? "stateOn" : "stateOff";
  return (
    <button
      ref={ref}
      type="button"
      onClick={onOpen}
      aria-label={t("skills.pane.cardLabel", {
        name: skill.displayName,
        state: t(`skills.pane.${state}`),
      })}
      className={cn(
        "group flex w-full min-w-0 items-center gap-3 p-3 text-start transition-colors hover:bg-text-primary/3 outline-none focus-visible:ring-2 focus-visible:ring-focus/30",
        CARD_SURFACE_CLASS
      )}
    >
      <SkillTile name={skill.name} on={skill.enabled && skill.valid} />
      <div className="flex-1 min-w-0">
        <p dir="auto" className="text-xs font-semibold text-primary truncate">
          {skill.displayName}
        </p>
        <p dir="auto" className="text-xs text-secondary/70 mt-0.5 truncate">
          {skill.description}
        </p>
      </div>
      {!skill.valid ? (
        <NeedsFixLabel />
      ) : skill.enabled ? (
        <Check size={14} className="shrink-0 text-secondary/60" />
      ) : (
        <span className="shrink-0 text-[11px] text-secondary/70">{t("skills.pane.off")}</span>
      )}
    </button>
  );
}

interface RecommendedSkillCardProps {
  title: string;
  description: string;
  onAdd: () => void;
}

export function RecommendedSkillCard({
  title,
  description,
  onAdd,
}: RecommendedSkillCardProps): ReactElement {
  const { t } = useTranslation();
  return (
    <div className={cn("flex w-full min-w-0 items-center gap-3 p-3", CARD_SURFACE_CLASS)}>
      <SkillTile on={false} />
      <div className="flex-1 min-w-0">
        <p dir="auto" className="text-xs font-semibold text-primary truncate">
          {title}
        </p>
        <p dir="auto" title={description} className="text-xs text-secondary/70 mt-0.5 truncate">
          {description}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onAdd}
        aria-label={t("skills.pane.addRecommended", { name: title })}
        className="size-8 px-0 shrink-0"
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
