import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Breadcrumb } from "../ui/Breadcrumb";
import { SettingsPanel } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";
import { useToast } from "../ui/useToast";
import { IntegrationsPane } from "../integrations/IntegrationsPane";
import { setSkillEnabled, useSkillsStore } from "../../stores/skillsStore";
import { SkillActionsMenu } from "./SkillActionsMenu";
import { NeedsFixLabel, SkillTile } from "./SkillCards";
import { SkillSearchInput } from "./SkillSearchInput";
import { problemKey, writeFailedToast } from "./skillCopy";

interface ManageSkillsScreenProps {
  onOpenSkill: (name: string, confirmUninstall: boolean) => void;
  onBack: () => void;
}

export function ManageSkillsScreen({ onOpenSkill, onBack }: ManageSkillsScreenProps): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const skills = useSkillsStore((state) => state.skills);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = skills.filter(
    (skill) => !needle || `${skill.displayName} ${skill.description}`.toLowerCase().includes(needle)
  );
  const switchSkill = async (name: string, next: boolean) => {
    if (!(await setSkillEnabled(name, next))) toast(writeFailedToast(t));
  };

  return (
    <IntegrationsPane
      breadcrumb={
        <Breadcrumb
          label={t("skills.breadcrumb.label")}
          items={[
            { label: t("skills.breadcrumb.root"), onSelect: onBack },
            { label: t("skills.manage.title") },
          ]}
        />
      }
      title={t("skills.manage.title")}
      description={t("skills.manage.description")}
      actions={<SkillSearchInput value={query} onChange={setQuery} />}
    >
      {shown.length === 0 ? (
        <p className="ps-1 text-xs text-muted-foreground">
          {skills.length > 0
            ? t("skills.manage.noMatches", { query: query.trim() })
            : t("skills.manage.none")}
        </p>
      ) : (
        <SettingsPanel>
          {shown.map((skill) => (
            <div
              key={skill.name}
              className="px-4 py-3 transition-colors hover:bg-foreground/3 dark:hover:bg-white/3"
            >
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => onOpenSkill(skill.name, false)}
                  className="flex flex-1 min-w-0 items-center gap-3 text-start rounded-md outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
                >
                  <SkillTile name={skill.name} on={skill.enabled && skill.valid} />
                  <div className="flex-1 min-w-0">
                    <p dir="auto" className="text-xs font-semibold text-foreground truncate">
                      {skill.displayName}
                    </p>
                    <p
                      dir="auto"
                      className="text-xs text-muted-foreground/70 mt-0.5 leading-relaxed line-clamp-1"
                    >
                      {skill.description}
                    </p>
                  </div>
                </button>
                {!skill.valid && <NeedsFixLabel />}
                <SkillActionsMenu skill={skill} onUninstall={() => onOpenSkill(skill.name, true)} />
                <Toggle
                  checked={skill.enabled && skill.valid}
                  onChange={(next) => void switchSkill(skill.name, next)}
                  disabled={!skill.valid}
                  ariaLabel={
                    skill.problem
                      ? t("skills.detail.problem", {
                          reason: t(problemKey(skill.problem), skill.problem.values),
                        })
                      : t("skills.detail.toggle", { name: skill.displayName })
                  }
                />
              </div>
            </div>
          ))}
        </SettingsPanel>
      )}
    </IntegrationsPane>
  );
}
