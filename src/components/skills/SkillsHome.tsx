import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  Settings,
  SkillStack,
  Upload,
} from "../icons";
import { Button } from "../ui/button";
import EmptyStateCard from "../ui/EmptyStateCard";
import { SectionLabel } from "../ui/SettingsSection";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useToast } from "../ui/useToast";
import { IntegrationsPane } from "../integrations/IntegrationsPane";
import { playSkillIcon, refreshSkills, useSkillsStore } from "../../stores/skillsStore";
import { InstalledSkillCard, RecommendedSkillCard } from "./SkillCards";
import { problemKey, RECOMMENDED_SKILL_IDS, writeFailedToast } from "./skillCopy";
import { SkillSearchInput } from "./SkillSearchInput";

const VISIBLE_INSTALLED = 6;

/** The home controls that open another screen; coming back focuses the one used. */
export type SkillsHomeControl = "manage" | "seeMore" | "add";

interface SkillsHomeProps {
  title: string;
  restoreFocus?: SkillsHomeControl | null;
  /** Skills that another screen just added: their icons play and the first takes focus. */
  arrived?: string[];
  onOpenSkill: (name: string) => void;
  onManage: (from: SkillsHomeControl) => void;
  onCreate: () => void;
  onUpload: () => void;
}

export function SkillsHome({
  title,
  restoreFocus,
  arrived = [],
  onOpenSkill,
  onManage,
  onCreate,
  onUpload,
}: SkillsHomeProps): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const skills = useSkillsStore((state) => state.skills);
  const loaded = useSkillsStore((state) => state.loaded);
  const loadError = useSkillsStore((state) => state.loadError);
  const [query, setQuery] = useState("");
  // Skills that just arrived. Once their cards are on screen the first takes focus and each
  // icon plays: a card mounted after the play count changed would not play.
  const [arrivals, setArrivals] = useState<string[]>(arrived);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  // A second press while one add is under way would add and toast twice.
  const adding = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const controlRefs = {
    manage: useRef<HTMLButtonElement>(null),
    seeMore: useRef<HTMLButtonElement>(null),
    add: useRef<HTMLButtonElement>(null),
  };

  // Coming back from another screen focuses the control that opened it.
  useEffect(() => {
    if (restoreFocus && arrived.length === 0) controlRefs[restoreFocus].current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the screen mounts
  }, []);

  useEffect(() => {
    if (arrivals.length === 0) return;
    const shown = arrivals.filter((name) => cardRefs.current.has(name));
    if (shown.length > 0) cardRefs.current.get(shown[0])?.focus();
    shown.forEach(playSkillIcon);
    setArrivals([]);
  }, [arrivals]);

  const needle = query.trim().toLowerCase();
  const matches = (text: string) => !needle || text.toLowerCase().includes(needle);
  const installed = skills.filter((skill) => matches(`${skill.displayName} ${skill.description}`));
  const shownInstalled = needle ? installed : installed.slice(0, VISIBLE_INSTALLED);
  const hiddenInstalled = needle ? [] : installed.slice(VISIBLE_INSTALLED);
  const recommended = RECOMMENDED_SKILL_IDS.filter(
    (id) => !skills.some((skill) => skill.name === id)
  )
    .map((id) => ({
      id,
      title: t(`skills.recommended.${id}.title`),
      description: t(`skills.recommended.${id}.description`),
    }))
    .filter((entry) => matches(`${entry.title} ${entry.description}`));

  const addRecommended = async ({ id, title: name, description }: (typeof recommended)[number]) => {
    if (adding.current) return;
    adding.current = true;
    try {
      const result = await window.electronAPI?.skillsAddRecommended?.(id, {
        title: name,
        description,
      });
      if (result && "problems" in result) {
        const [problem] = result.problems;
        toast({
          title: t("skills.toasts.writeFailed"),
          description: t(problemKey(problem), problem.values),
          variant: "destructive",
        });
        return;
      }
      if (!result?.ok) {
        toast(writeFailedToast(t, result && "error" in result ? result.error : undefined));
        return;
      }
      await refreshSkills();
      setArrivals([result.name]);
      toast({ title: t("skills.toasts.added", { name }), variant: "success" });
    } finally {
      adding.current = false;
    }
  };

  const [firstHidden, secondHidden] = hiddenInstalled.map((skill) => skill.displayName);
  const seeLabel =
    hiddenInstalled.length === 1
      ? t("skills.pane.seeOne", { first: firstHidden })
      : hiddenInstalled.length === 2
        ? t("skills.pane.seeTwo", { first: firstHidden, second: secondHidden })
        : t("skills.pane.seeMore", {
            first: firstHidden,
            second: secondHidden,
            count: hiddenInstalled.length - 2,
          });

  // The card holding Retry goes once the list loads, so the heading takes focus; a Retry
  // that fails again says so.
  const retry = async () => {
    await refreshSkills();
    if (useSkillsStore.getState().loadError) {
      toast({ title: t("skills.toasts.loadFailed"), variant: "destructive" });
    } else heading.current?.focus();
  };

  const recommendedSection = recommended.length > 0 && (
    <div className="pt-2">
      <SectionLabel>{t("skills.pane.recommended")}</SectionLabel>
      <div className="grid grid-cols-2 gap-2">
        {recommended.map((entry) => (
          <RecommendedSkillCard
            key={entry.id}
            title={entry.title}
            description={entry.description}
            onAdd={() => void addRecommended(entry)}
          />
        ))}
      </div>
    </div>
  );

  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={controlRefs.add} variant="outline" size="sm">
          <Plus className="h-3.5 w-3.5" />
          {t("skills.pane.add")}
          <ChevronDown className="h-3 w-3 -me-0.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-52">
        <DropdownMenuItem onSelect={onCreate} className="gap-2.5">
          <Pencil className="h-4 w-4" />
          {t("skills.pane.addMenu.create")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onUpload} className="gap-2.5">
          <Upload className="h-4 w-4" />
          {t("skills.pane.addMenu.upload")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <IntegrationsPane
      title={title}
      headingRef={heading}
      description={t("skills.pane.description")}
      actions={
        skills.length === 0 ? (
          addMenu
        ) : (
          <>
            <SkillSearchInput value={query} onChange={setQuery} />
            <Button
              ref={controlRefs.manage}
              variant="outline"
              size="sm"
              onClick={() => onManage("manage")}
              aria-label={t("skills.pane.manage")}
              title={t("skills.pane.manage")}
              className="size-8 px-0"
            >
              <Settings className="h-3.5 w-3.5" />
            </Button>
            {addMenu}
          </>
        )
      }
    >
      {!loaded && loadError && (
        <EmptyStateCard icon={AlertTriangle} title={t("skills.toasts.loadFailed")} headingLevel={3}>
          <Button size="sm" variant="outline" onClick={() => void retry()}>
            {t("common.retry")}
          </Button>
        </EmptyStateCard>
      )}
      {loaded &&
        (skills.length === 0 ? (
          <>
            <EmptyStateCard
              icon={SkillStack}
              title={t("skills.pane.empty.title")}
              description={t("skills.pane.empty.description")}
              headingLevel={3}
            >
              <Button size="sm" onClick={onUpload}>
                <Upload className="h-3.5 w-3.5" />
                {t("skills.pane.addMenu.upload")}
              </Button>
            </EmptyStateCard>
            {recommendedSection}
          </>
        ) : (
          <div>
            <div>
              <SectionLabel>{t("skills.pane.installed")}</SectionLabel>
              {installed.length > 0 ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    {shownInstalled.map((skill) => (
                      <InstalledSkillCard
                        key={skill.name}
                        skill={skill}
                        onOpen={() => onOpenSkill(skill.name)}
                        ref={(element) => {
                          if (element) cardRefs.current.set(skill.name, element);
                          else cardRefs.current.delete(skill.name);
                        }}
                      />
                    ))}
                  </div>
                  {hiddenInstalled.length > 0 && (
                    <button
                      ref={controlRefs.seeMore}
                      type="button"
                      onClick={() => onManage("seeMore")}
                      className="mt-2 ms-1 inline-flex items-center gap-1 rounded-sm text-xs text-primary/80 hover:text-primary outline-none focus-visible:ring-1 focus-visible:ring-primary/30 transition-colors"
                    >
                      {seeLabel}
                      <ChevronRight className="h-3 w-3 rtl:rotate-180" />
                    </button>
                  )}
                </>
              ) : (
                <p className="ps-1 text-xs text-muted-foreground">
                  {t("skills.pane.noMatches", { query: query.trim() })}
                </p>
              )}
            </div>
            {recommendedSection}
          </div>
        ))}
    </IntegrationsPane>
  );
}
