import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Info, Loader2, Plus, X } from "../icons";
import { ConfirmDialog } from "../ui/dialog";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "../ui/select";
import { Button } from "../ui/button";
import { useDialogs } from "../../hooks/useDialogs";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import CreateTeamDialog from "../CreateTeamDialog";
import { TeamsService } from "../../services/TeamsService";
import {
  assignTeamToSpace,
  setSpaceTeamAccess,
  unassignTeamFromSpace,
} from "../../services/spaceActions";
import { useToast } from "../ui/useToast";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { canManageSpace, canManageWorkspace } from "../../lib/spacePermissions";
import type { SpaceItem, SpaceTeamRef, Team } from "../../types/electron";

interface SpaceGroupsSectionProps {
  space: SpaceItem;
  /** Fires after any assignment change so the people list can refetch. */
  onChanged: () => void;
}

// Groups (teams) assigned to a space and the controls to change them:
// assign, per-assignment access cap, unassign, new group. The people the
// groups bring in are shown in the flat roster above this section.
export default function SpaceGroupsSection({ space, onChanged }: SpaceGroupsSectionProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const workspaceRole = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === space.workspace_id)?.role ?? null
  );
  const [workspaceTeams, setWorkspaceTeams] = useState<Team[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [teamsError, setTeamsError] = useState(false);
  const [pendingTeamId, setPendingTeamId] = useState<string | null>(null);
  const [isAssigning, setIsAssigning] = useState(false);
  const showAssignSpinner = useDelayedFlag(isAssigning);
  const [newTeamOpen, setNewTeamOpen] = useState(false);
  const [accessBusyTeamId, setAccessBusyTeamId] = useState<string | null>(null);

  const canManage = canManageSpace(space, workspaceRole);
  // Group creation is 403'd below workspace admin.
  const isWorkspaceAdmin = canManageWorkspace(workspaceRole);

  const loadWorkspaceTeams = useCallback(async (workspaceId: string) => {
    setTeamsLoading(true);
    setTeamsError(false);
    try {
      setWorkspaceTeams(await TeamsService.list(workspaceId));
    } catch {
      setWorkspaceTeams([]);
      setTeamsError(true);
    } finally {
      setTeamsLoading(false);
    }
  }, []);

  useEffect(() => {
    // Any workspace member may list teams; counts feed the rows.
    if (space.workspace_id) void loadWorkspaceTeams(space.workspace_id);
  }, [space.workspace_id, loadWorkspaceTeams]);

  const unassignedTeams = useMemo(
    () => workspaceTeams.filter((team) => !space.teams.some((t) => t.id === team.id)),
    [workspaceTeams, space.teams]
  );

  const memberCountByTeam = useMemo(
    () => new Map(workspaceTeams.map((team) => [team.id, team.member_count ?? 0])),
    [workspaceTeams]
  );

  const reportError = (err: unknown) => {
    toast({
      title: t("common.error"),
      description: err instanceof Error ? err.message : t("common.unknownError"),
      variant: "destructive",
    });
  };

  const confirmUnassignTeam = (teamId: string, teamName: string) => {
    showConfirmDialog({
      title: t("notes.spaces.teamsMembers.removeTeamConfirm", {
        team: teamName,
        space: space.name,
      }),
      description: t("notes.spaces.teamsMembers.removeTeamConfirmDescription"),
      confirmText: t("notes.spaces.teamsMembers.removeTeamFromSpace"),
      variant: "destructive",
      onConfirm: async () => {
        try {
          await unassignTeamFromSpace(space, teamId);
          toast({
            title: t("notes.spaces.teamsMembers.teamRemoved", {
              team: teamName,
              space: space.name,
            }),
          });
          onChanged();
        } catch (err) {
          reportError(err);
        }
      },
    });
  };

  const assignTeam = async (team: Team) => {
    await assignTeamToSpace(space, team.id);
    toast({
      title: t("notes.spaces.teamsMembers.teamAdded", { team: team.name, space: space.name }),
    });
    onChanged();
  };

  const handleAssignTeam = async () => {
    const team = unassignedTeams.find((candidate) => candidate.id === pendingTeamId);
    if (!team || isAssigning) return;
    setIsAssigning(true);
    try {
      await assignTeam(team);
      setPendingTeamId(null);
    } catch (err) {
      reportError(err);
    } finally {
      setIsAssigning(false);
    }
  };

  // Downgrading the caller's only admin-granting team is allowed (symmetric
  // with unassign): reversible by any workspace admin and never touches
  // content access. The mirror refresh flips canManage if it applies.
  const handleAccessChange = async (teamRef: SpaceTeamRef, access: "admin" | "member") => {
    if (access === (teamRef.access ?? "admin") || accessBusyTeamId) return;
    setAccessBusyTeamId(teamRef.id);
    try {
      await setSpaceTeamAccess(space, teamRef.id, access);
      toast({
        title: t("notes.spaces.teamsMembers.accessChanged", { team: teamRef.name }),
      });
      onChanged();
    } catch (err) {
      reportError(err);
    } finally {
      setAccessBusyTeamId(null);
    }
  };

  // Registered in workspaceTeams before assignment: if assigning fails, the
  // new team still surfaces in the unassigned select for a retry.
  const handleTeamCreated = async (team: Team) => {
    setWorkspaceTeams((prev) => [...prev, team]);
    try {
      await assignTeam(team);
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <>
      <div className="space-y-3">
        {teamsError && space.workspace_id && (
          <div className="rounded border border-border/70 dark:border-border-subtle/60 px-3 py-2.5 flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">{t("notes.spaces.teams.loadError")}</p>
            <Button
              variant="ghost"
              size="sm"
              disabled={teamsLoading}
              onClick={() => {
                if (space.workspace_id) {
                  void loadWorkspaceTeams(space.workspace_id);
                }
              }}
              className="h-6 px-2 text-xs shrink-0"
            >
              {teamsLoading && <Loader2 className="me-1.5 h-3 w-3 animate-spin" />}
              {t("common.retry")}
            </Button>
          </div>
        )}

        {space.teams.length === 0 && (
          <p className="text-xs text-muted-foreground">{t("notes.spaces.teamsMembers.noTeams")}</p>
        )}

        {space.teams.map((teamRef) => {
          const memberCount = memberCountByTeam.get(teamRef.id);
          const access = teamRef.access ?? "admin";
          return (
            <div key={teamRef.id} className="space-y-1.5">
              <div className="flex items-center gap-1 -mx-1">
                <div className="flex flex-1 min-w-0 items-center gap-1.5 h-8 px-1.5">
                  <span dir="auto" className="text-xs font-semibold text-foreground truncate">
                    {teamRef.name}
                  </span>
                  {memberCount != null && (
                    <span className="ms-auto text-[10px] text-foreground/45 shrink-0">
                      {t("settingsPage.workspace.teams.memberCount", { count: memberCount })}
                    </span>
                  )}
                </div>
                {canManage ? (
                  <Select
                    value={access}
                    disabled={accessBusyTeamId === teamRef.id}
                    onValueChange={(next) =>
                      void handleAccessChange(teamRef, next as "admin" | "member")
                    }
                  >
                    <SelectTrigger
                      className="h-7 w-25 px-2 text-xs rounded-md shrink-0"
                      aria-label={t("notes.spaces.teamsMembers.accessLabel")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin" className="text-xs">
                        {t("notes.spaces.teamsMembers.accessAdmin")}
                      </SelectItem>
                      <SelectItem value="member" className="text-xs">
                        {t("notes.spaces.teamsMembers.accessMember")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-[10px] text-foreground/45 shrink-0 px-1">
                    {t(
                      access === "admin"
                        ? "notes.spaces.teamsMembers.accessAdmin"
                        : "notes.spaces.teamsMembers.accessMember"
                    )}
                  </span>
                )}
                {canManage && (
                  <button
                    type="button"
                    onClick={() => confirmUnassignTeam(teamRef.id, teamRef.name)}
                    aria-label={t("notes.spaces.teamsMembers.removeTeamFromSpace")}
                    className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/8 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-primary/30 shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              {access === "member" && (
                <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                  <Info size={12} className="shrink-0 mt-px" />
                  {t("notes.spaces.teamsMembers.accessHint", { team: teamRef.name })}
                </p>
              )}
            </div>
          );
        })}

        {((canManage && unassignedTeams.length > 0) || isWorkspaceAdmin) && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground/50">
              {t("notes.spaces.teamsMembers.addTeamLabel")}
            </label>
            {canManage && unassignedTeams.length > 0 && (
              <div className="flex items-center gap-2">
                <Select value={pendingTeamId ?? ""} onValueChange={setPendingTeamId}>
                  <SelectTrigger className="h-8 flex-1 text-xs">
                    <SelectValue placeholder={t("notes.spaces.teamsMembers.chooseTeam")} />
                  </SelectTrigger>
                  <SelectContent>
                    {unassignedTeams.map((team) => (
                      <SelectItem key={team.id} value={team.id} className="text-xs">
                        <span dir="auto">{team.name}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  onClick={() => void handleAssignTeam()}
                  disabled={!pendingTeamId || isAssigning}
                  className="h-8 shrink-0"
                >
                  {showAssignSpinner && <Loader2 className="me-1.5 h-3 w-3 animate-spin" />}
                  {t("common.add")}
                </Button>
              </div>
            )}
            {isWorkspaceAdmin && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setNewTeamOpen(true)}
                className="h-7 px-2 text-xs text-foreground/60"
              >
                <Plus size={12} className="me-1" />
                {t("notes.spaces.teams.newTeam")}
              </Button>
            )}
          </div>
        )}
      </div>

      {space.workspace_id && (
        <CreateTeamDialog
          workspaceId={space.workspace_id}
          open={newTeamOpen}
          onOpenChange={setNewTeamOpen}
          onCreated={handleTeamCreated}
        />
      )}

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(o) => !o && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
    </>
  );
}
