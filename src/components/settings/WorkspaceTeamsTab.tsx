import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { useWorkspaceTeams } from "../../hooks/useWorkspaceTeams";
import { teamCreationFor } from "../../lib/capabilities";
import { Button } from "../ui/button";
import { useToast } from "../ui/useToast";
import CreateTeamDialog from "../CreateTeamDialog";
import TeamMembersDialog from "./TeamMembersDialog";
import TeamsTable from "./TeamsTable";
import type { Team, Workspace } from "../../types/electron";

interface Props {
  workspace: Workspace;
}

export default function WorkspaceTeamsTab({ workspace }: Props): React.ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { status, teams, stale, reload } = useWorkspaceTeams(workspace.id);
  const [createOpen, setCreateOpen] = useState(false);
  const [openTeam, setOpenTeam] = useState<Team | null>(null);
  // Only whether Create is offered; a workspace below Business still sees it, and the opener
  // decides what pressing it does.
  const canCreate = teamCreationFor(workspace) !== "unavailable";

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
        onCreate={() => setCreateOpen(true)}
        onOpen={setOpenTeam}
      />

      <CreateTeamDialog
        workspaceId={workspace.id}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(team) => {
          toast({ title: t("settingsPage.workspace.teams.created", { team: team.name }) });
          return reload().then(() => undefined);
        }}
      />

      {openTeam && (
        <TeamMembersDialog
          team={openTeam}
          workspace={workspace}
          open
          onOpenChange={(open) => {
            if (!open) {
              setOpenTeam(null);
              void reload();
            }
          }}
        />
      )}
    </div>
  );
}
