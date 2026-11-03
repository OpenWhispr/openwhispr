import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Building2, Lock, Users } from "../icons";
import { SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";
import { UpsellBar } from "../integrations/IntegrationsPane";
import type { SharedScope } from "../../types/sharedDictionary";
import { workspaceListLabel, type SharedAccessState } from "./dictionaryViewModel";

export type LockedAccessState = Exclude<SharedAccessState, "available" | "unavailable">;

interface SharedDictionaryUpsellProps {
  access: LockedAccessState;
  workspaceName: string;
  // The lists the last pass read; empty when none were read for this workspace.
  scopes: SharedScope[];
  // Whether the member's role can buy a plan; only those who can get View plans.
  canManage: boolean;
  onUpgrade: () => void;
}

interface LockedRow {
  key: string;
  icon: ReactNode;
  title: string;
  subtitle: string;
}

const workspaceFirst = (scopes: SharedScope[]): SharedScope[] => [
  ...scopes.filter((scope) => scope.space_id === null),
  ...scopes.filter((scope) => scope.space_id !== null),
];

const WORKSPACE_ICON = <Building2 className="h-4 w-4 text-primary/80" aria-hidden="true" />;
const SPACE_ICON = <Users className="h-4 w-4 text-primary/80" aria-hidden="true" />;

// Neither a sign-in nor lost access is fixed by a plan, so they get no lists and no button.
const ACCESS_BLOCKED = new Set<LockedAccessState>(["ssoRequired", "noAccess"]);
const LOCK_ICON = <Lock size={15} className="shrink-0 text-primary" aria-hidden="true" />;

/** The upsell for a Shared list the member can't use; a member can't buy, so gets no button. */
export function SharedDictionaryUpsell({
  access,
  workspaceName,
  scopes,
  canManage,
  onUpgrade,
}: SharedDictionaryUpsellProps): ReactElement {
  const { t } = useTranslation();
  if (access === "ssoRequired" || access === "noAccess") {
    return (
      <UpsellBar
        icon={LOCK_ICON}
        message={t(`dictionary.shared.locked.${access}`, { workspace: workspaceName })}
      />
    );
  }
  if (access === "upgradeMember") {
    return (
      <UpsellBar
        message={t("dictionary.shared.locked.upgradeMember", { workspace: workspaceName })}
      />
    );
  }
  if (access === "paused") {
    const count = scopes.reduce((total, scope) => total + scope.word_count, 0);
    return canManage ? (
      <UpsellBar
        message={t("dictionary.shared.locked.paused", { workspace: workspaceName, count })}
        onUpgrade={onUpgrade}
      />
    ) : (
      <UpsellBar
        message={t("dictionary.shared.locked.pausedMember", { workspace: workspaceName, count })}
      />
    );
  }
  const message =
    access === "noWorkspace"
      ? t("dictionary.shared.locked.noWorkspace")
      : t("dictionary.shared.locked.upgradeAdmin", { workspace: workspaceName });
  return <UpsellBar message={message} onUpgrade={onUpgrade} />;
}

/** The upsell above the lists Business would give, or keeps paused, dimmed and locked. */
export function SharedDictionaryLocked(props: SharedDictionaryUpsellProps): ReactElement {
  const { access, workspaceName, scopes } = props;
  const { t } = useTranslation();

  // Without real lists to show (no workspace, or none read yet) the rows say what Business adds.
  const describedRows = (workspaceTitle: string): LockedRow[] => [
    {
      key: "workspace",
      icon: WORKSPACE_ICON,
      title: workspaceTitle,
      subtitle: t("dictionary.shared.locked.workspaceDescription"),
    },
    {
      key: "space",
      icon: SPACE_ICON,
      title: t("dictionary.shared.locked.spaceTitle"),
      subtitle: t("dictionary.shared.locked.spaceDescription"),
    },
  ];

  if (ACCESS_BLOCKED.has(access)) return <SharedDictionaryUpsell {...props} />;

  const rows: LockedRow[] =
    access === "noWorkspace"
      ? describedRows(t("dictionary.shared.locked.workspaceTitle"))
      : scopes.length === 0
        ? describedRows(workspaceListLabel(workspaceName, t))
        : workspaceFirst(scopes).map((scope) => ({
            key: scope.space_id ?? "workspace",
            icon: scope.space_id === null ? WORKSPACE_ICON : SPACE_ICON,
            title: scope.space_id === null ? workspaceListLabel(workspaceName, t) : scope.name,
            // Paused lists show what was kept; the others who the list would reach.
            subtitle:
              access === "paused"
                ? t("dictionary.shared.locked.wordCount", { count: scope.word_count })
                : t("dictionary.shared.memberCount", { count: scope.member_count }),
          }));

  return (
    <div className="space-y-3">
      <SharedDictionaryUpsell {...props} />
      <SettingsPanel>
        {rows.map((row) => (
          <SettingsPanelRow key={row.key}>
            <div className="flex items-center gap-3 opacity-60">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/5 dark:bg-primary/10">
                {row.icon}
              </div>
              <div className="min-w-0 flex-1">
                <p dir="auto" className="truncate text-xs font-semibold text-foreground">
                  {row.title}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/70">
                  {row.subtitle}
                </p>
              </div>
              <Lock
                size={14}
                role="img"
                aria-label={t("dictionary.shared.locked.lockLabel")}
                className="shrink-0 text-muted-foreground"
              />
            </div>
          </SettingsPanelRow>
        ))}
      </SettingsPanel>
    </div>
  );
}
