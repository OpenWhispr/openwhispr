import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceTeams } from "../../hooks/useWorkspaceTeams";
import { teamCreationFor } from "../../lib/capabilities";
import { Button } from "../ui/button";
import CreateTeamDialog from "../CreateTeamDialog";
import TeamPaywallDialog from "../workspace/TeamPaywallDialog";
import TeamSettingsDialog from "./TeamSettingsDialog";
import TeamsTable from "./TeamsTable";
import type { Workspace } from "../../types/electron";

interface Props {
  workspace: Workspace;
  /** People asked for Create team from outside this tab (the Add menu); handled once. */
  openCreateRequested?: boolean;
  onCreateRequestHandled?: () => void;
  /** Whether the list has loaded with no team in it, so the page can leave Add to this tab. */
  onTeamsEmptyChange?: (empty: boolean) => void;
}

export default function WorkspaceTeamsTab({
  workspace,
  openCreateRequested = false,
  onCreateRequestHandled,
  onTeamsEmptyChange,
}: Props): React.ReactElement {
  const { t } = useTranslation();
  const { status, teams, stale, reload } = useWorkspaceTeams(workspace.id);
  const [createOpen, setCreateOpen] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [openTeamId, setOpenTeamId] = useState<string | null>(null);
  // A dialog belongs to the workspace it was opened in: switching away and back doesn't reopen it.
  const [dialogWorkspaceId, setDialogWorkspaceId] = useState(workspace.id);
  if (workspace.id !== dialogWorkspaceId) {
    setDialogWorkspaceId(workspace.id);
    setOpenTeamId(null);
    // Create would otherwise send the people of the old workspace to the new one's teams route.
    setCreateOpen(false);
    setPaywallOpen(false);
  }
  // Read from the list, so a rename or a reload reaches the open dialog; a team the list no
  // longer has (deleted, left) takes its dialog with it.
  const openTeam = teams.find((team) => team.id === openTeamId) ?? null;
  // Only whether Create is offered; a workspace below Business still sees it, and the opener
  // decides what pressing it does.
  const canCreate = teamCreationFor(workspace) !== "unavailable";

  // The one place that decides what Create does: the form, or the paywall below Business.
  const openCreate = (): void => {
    const creation = teamCreationFor(workspace);
    if (creation === "allowed") setCreateOpen(true);
    else if (creation === "paywall") setPaywallOpen(true);
  };

  const empty = status === "ready" && teams.length === 0;
  useEffect(() => {
    onTeamsEmptyChange?.(empty);
    return () => onTeamsEmptyChange?.(false);
  }, [empty, onTeamsEmptyChange]);

  useEffect(() => {
    if (!openCreateRequested) return;
    openCreate();
    onCreateRequestHandled?.();
    // Only a new request matters; the opener reads the workspace as it is right then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCreateRequested]);

  return (
    <div className="space-y-4">
      {stale && (
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <p>{t("settingsPage.workspace.teams.refreshFailed")}</p>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            {t("workspaces.exit.tryAgain")}
          </Button>
        </div>
      )}

      <TeamsTable
        status={status}
        teams={teams}
        canCreate={canCreate}
        onRetry={() => void reload()}
        onCreate={openCreate}
        onOpen={(team) => setOpenTeamId(team.id)}
      />

      <CreateTeamDialog
        workspace={workspace}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={async () => {
          await reload();
        }}
        onPlanRequired={() => {
          setCreateOpen(false);
          setPaywallOpen(true);
        }}
      />

      <TeamPaywallDialog workspace={workspace} open={paywallOpen} onOpenChange={setPaywallOpen} />

      {openTeam && (
        <TeamSettingsDialog
          team={openTeam}
          workspace={workspace}
          open
          onOpenChange={(open) => {
            if (!open) {
              setOpenTeamId(null);
              void reload();
            }
          }}
          onChanged={() => void reload()}
          onGone={() => {
            setOpenTeamId(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}
