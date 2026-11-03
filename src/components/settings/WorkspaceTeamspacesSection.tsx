import React from "react";
import { useTranslation } from "react-i18next";
import SettingsWorkspaceFrame from "./SettingsWorkspaceFrame";
import { useSettingsWorkspace } from "./useSettingsWorkspace";

interface Props {
  /** Takes the user to a teamspace in Notes. */
  onOpenTeamspace?: (localSpaceId: number) => void;
}

export default function WorkspaceTeamspacesSection(_props: Props): React.ReactElement | null {
  const { t } = useTranslation();
  const state = useSettingsWorkspace();
  return (
    <SettingsWorkspaceFrame state={state}>
      {() => (
        <h2 className="text-sm font-semibold text-foreground">
          {t("settingsPage.workspace.teamspaces.title")}
        </h2>
      )}
    </SettingsWorkspaceFrame>
  );
}
