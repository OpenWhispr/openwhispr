import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../lib/utils";
import WorkspaceMembersTab from "./WorkspaceMembersTab";
import WorkspaceTeamsTab from "./WorkspaceTeamsTab";
import SettingsWorkspaceFrame from "./SettingsWorkspaceFrame";
import { useSettingsWorkspace } from "./useSettingsWorkspace";

const PEOPLE_TABS = ["members", "teams"] as const;
type PeopleTab = (typeof PEOPLE_TABS)[number];

const PEOPLE_TAB_KEY = "settings.workspacePeopleTab";
// The single Workspace page kept its tab here; a Members or Teams choice carries over once.
const LEGACY_WORKSPACE_TAB_KEY = "settings.workspaceTab";

function isPeopleTab(value: unknown): value is PeopleTab {
  return PEOPLE_TABS.includes(value as PeopleTab);
}

function legacyPeopleTab(): PeopleTab | null {
  try {
    const raw = localStorage.getItem(LEGACY_WORKSPACE_TAB_KEY);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return isPeopleTab(value) ? value : null;
  } catch {
    return null;
  }
}

interface Props {
  initialSubTab?: string;
}

export default function WorkspacePeopleSection({
  initialSubTab,
}: Props): React.ReactElement | null {
  const { t } = useTranslation();
  const state = useSettingsWorkspace();
  const [storedTab, setStoredTab] = useLocalStorage<string>(
    PEOPLE_TAB_KEY,
    isPeopleTab(initialSubTab) ? initialSubTab : (legacyPeopleTab() ?? "members")
  );

  useEffect(() => {
    if (isPeopleTab(initialSubTab)) setStoredTab(initialSubTab);
  }, [initialSubTab, setStoredTab]);

  const tab: PeopleTab = isPeopleTab(storedTab) ? storedTab : "members";

  return (
    <SettingsWorkspaceFrame state={state}>
      {(workspace) => (
        <>
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              {t("settingsPage.workspace.people.title")}
            </h2>
            <p className="text-xs text-muted-foreground/80 mt-0.5">
              {t("settingsPage.workspace.people.description")}
            </p>
          </div>

          <div className="border-b border-border/70 dark:border-border-subtle/60 -mx-1">
            <div role="tablist" className="flex gap-0.5 px-1">
              {PEOPLE_TABS.map((id) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setStoredTab(id)}
                  className={cn(
                    "px-3 h-8 text-xs font-medium outline-none transition-colors relative",
                    "focus-visible:ring-1 focus-visible:ring-primary/30 rounded-md",
                    tab === id ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {t(`settingsPage.workspace.tab.${id}`)}
                  {tab === id && (
                    <span className="absolute -bottom-px left-2 right-2 h-px bg-primary" />
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="pt-1">
            {tab === "members" && <WorkspaceMembersTab workspace={workspace} />}
            {tab === "teams" && <WorkspaceTeamsTab workspace={workspace} />}
          </div>
        </>
      )}
    </SettingsWorkspaceFrame>
  );
}
