import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { ChevronRight, Info, Loader2, Plus, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, ConfirmDialog } from "../ui/dialog";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "../ui/select";
import { Button } from "../ui/button";
import { useDialogs } from "../../hooks/useDialogs";
import { useAuth } from "../../hooks/useAuth";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { cn } from "../lib/utils";
import CreateTeamDialog from "../CreateTeamDialog";
import InviteTeammateDialog from "../InviteTeammateDialog";
import TeamRosterSection from "../TeamRosterSection";
import { TeamsService } from "../../services/TeamsService";
import {
  assignTeamToSpace,
  setSpaceTeamAccess,
  unassignTeamFromSpace,
} from "../../services/spaceActions";
import { useToast } from "../ui/useToast";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useSpaces } from "../../stores/noteStore";
import { canManageSpace, canManageTeamRoster } from "../../lib/spacePermissions";
import type { SpaceItem, SpaceTeamRef, Team, TeamMember } from "../../types/electron";

interface SpaceMembersDialogProps {
  space: SpaceItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SpaceMembersDialog({ space, open, onOpenChange }: SpaceMembersDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const spaces = useSpaces();
  const {
    workspace,
    members: roster,
    refreshMembers,
  } = useWorkspaceStore(
    useShallow((s) => ({
      workspace: s.workspaces.find((w) => w.id === space.workspace_id),
      members: s.members,
      refreshMembers: s.refreshMembers,
    }))
  );
  const [workspaceTeams, setWorkspaceTeams] = useState<Team[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState<string | undefined>(undefined);
  const [inviteTeamId, setInviteTeamId] = useState<string | null>(null);
  const [pendingTeamId, setPendingTeamId] = useState<string | null>(null);
  const [isAssigning, setIsAssigning] = useState(false);
  const showAssignSpinner = useDelayedFlag(isAssigning);
  // Per-team expansion; absent = default (expanded only for single-team spaces).
  const [expandedOverrides, setExpandedOverrides] = useState<Map<string, boolean>>(new Map());
  const [newTeamOpen, setNewTeamOpen] = useState(false);
  const [accessBusyTeamId, setAccessBusyTeamId] = useState<string | null>(null);

  const canManage = canManageSpace(space, workspace?.role ?? null);
  const isWorkspaceAdmin = workspace?.role === "owner" || workspace?.role === "admin";
  // Team creation and workspace invites are 403'd below workspace admin.
  const canInviteToWorkspace = isWorkspaceAdmin;

  const isTeamExpanded = (teamId: string): boolean =>
    expandedOverrides.get(teamId) ?? space.teams.length === 1;

  const toggleTeamExpanded = (teamId: string): void => {
    setExpandedOverrides((prev) => new Map(prev).set(teamId, !isTeamExpanded(teamId)));
  };

  useEffect(() => {
    if (!open) {
      setInviteEmail(undefined);
      setInviteTeamId(null);
      setPendingTeamId(null);
      setExpandedOverrides(new Map());
      setNewTeamOpen(false);
      setAccessBusyTeamId(null);
      return;
    }
    if (space.workspace_id) {
      void refreshMembers(space.workspace_id).catch(() => {});
      // Any workspace member may list teams; counts feed the collapsed rows.
      void TeamsService.list(space.workspace_id)
        .then(setWorkspaceTeams)
        .catch(() => setWorkspaceTeams([]));
    }
  }, [open, space.workspace_id, refreshMembers]);

  // How many OTHER spaces each assigned team backs — roster edits ripple there.
  const otherSpacesByTeam = useMemo(() => {
    const counts = new Map<string, number>();
    for (const teamRef of space.teams) {
      counts.set(
        teamRef.id,
        spaces.filter((s) => s.id !== space.id && s.teams.some((t) => t.id === teamRef.id)).length
      );
    }
    return counts;
  }, [spaces, space]);

  const unassignedTeams = useMemo(
    () => workspaceTeams.filter((team) => !space.teams.some((t) => t.id === team.id)),
    [workspaceTeams, space.teams]
  );

  const memberCountByTeam = useMemo(
    () => new Map(workspaceTeams.map((team) => [team.id, team.member_count ?? 0])),
    [workspaceTeams]
  );

  const confirmRemoveMember = useCallback(
    (member: TeamMember, onConfirm: () => void) => {
      showConfirmDialog({
        title: t("notes.spaces.members.removeConfirm", {
          name: member.name || member.email,
          space: space.name,
        }),
        description: t("notes.spaces.members.removeConfirmDescription"),
        confirmText: t("notes.spaces.members.remove"),
        variant: "destructive",
        onConfirm,
      });
    },
    [showConfirmDialog, t, space.name]
  );

  const confirmUnassignTeam = (teamId: string, teamName: string) => {
    const isLastTeam = space.teams.length === 1;
    showConfirmDialog({
      title: t("notes.spaces.teamsMembers.removeTeamConfirm", {
        team: teamName,
        space: space.name,
      }),
      description: isLastTeam
        ? t("notes.spaces.teamsMembers.lastTeamWarning")
        : t("notes.spaces.teamsMembers.removeTeamConfirmDescription"),
      confirmText: t("notes.spaces.teamsMembers.removeTeamFromSpace"),
      variant: "destructive",
      onConfirm: async () => {
        try {
          await unassignTeamFromSpace(space, teamId);
        } catch (err) {
          toast({
            title: t("common.error"),
            description: err instanceof Error ? err.message : t("common.unknownError"),
            variant: "destructive",
          });
        }
      },
    });
  };

  const handleAssignTeam = async () => {
    const team = unassignedTeams.find((candidate) => candidate.id === pendingTeamId);
    if (!team || isAssigning) return;
    setIsAssigning(true);
    try {
      await assignTeamToSpace(space, team.id);
      setPendingTeamId(null);
      toast({
        title: t("notes.spaces.teamsMembers.teamAdded", { team: team.name, space: space.name }),
      });
    } catch (err) {
      toast({
        title: t("common.error"),
        description: err instanceof Error ? err.message : t("common.unknownError"),
        variant: "destructive",
      });
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
    } catch (err) {
      toast({
        title: t("common.error"),
        description: err instanceof Error ? err.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setAccessBusyTeamId(null);
    }
  };

  // Registered in workspaceTeams before assignment: if assigning fails, the
  // new team still surfaces in the unassigned select for a retry. The new
  // row stays collapsed like the rest — members were already picked in the
  // create dialog.
  const handleTeamCreated = async (team: Team) => {
    setWorkspaceTeams((prev) => [...prev, team]);
    try {
      await assignTeamToSpace(space, team.id);
      toast({
        title: t("notes.spaces.teamsMembers.teamAdded", { team: team.name, space: space.name }),
      });
    } catch (err) {
      toast({
        title: t("common.error"),
        description: err instanceof Error ? err.message : t("common.unknownError"),
        variant: "destructive",
      });
    }
  };

  if (!space.cloud_space_id) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("notes.spaces.teamsMembers.title", { space: space.name })}</DialogTitle>
          </DialogHeader>

          {space.teams.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {t("notes.spaces.teamsMembers.noTeams")}
            </p>
          )}

          {space.teams.map((teamRef) => {
            const otherSpaces = otherSpacesByTeam.get(teamRef.id) ?? 0;
            const memberCount = memberCountByTeam.get(teamRef.id);
            const expanded = isTeamExpanded(teamRef.id);
            return (
              <div key={teamRef.id} className="space-y-2">
                <div className="flex items-center gap-1 -mx-1">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => toggleTeamExpanded(teamRef.id)}
                    className={cn(
                      "flex flex-1 min-w-0 items-center gap-1.5 h-8 px-1.5 rounded-md",
                      "transition-colors duration-150 outline-none",
                      "hover:bg-foreground/4 dark:hover:bg-white/4",
                      "focus-visible:ring-1 focus-visible:ring-ring/30"
                    )}
                  >
                    <ChevronRight
                      size={12}
                      aria-hidden="true"
                      className={cn(
                        "shrink-0 text-foreground/40 transition-transform duration-150",
                        expanded && "rotate-90"
                      )}
                    />
                    <span className="text-xs font-semibold text-foreground truncate">
                      {teamRef.name}
                    </span>
                    {memberCount != null && (
                      <span className="ml-auto text-[10px] text-foreground/40 shrink-0">
                        {t("settingsPage.workspace.teams.memberCount", { count: memberCount })}
                      </span>
                    )}
                  </button>
                  {canManage ? (
                    <Select
                      value={teamRef.access ?? "admin"}
                      disabled={accessBusyTeamId === teamRef.id}
                      onValueChange={(access) =>
                        void handleAccessChange(teamRef, access as "admin" | "member")
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
                    <span className="text-[10px] text-foreground/40 shrink-0 px-1">
                      {t(
                        (teamRef.access ?? "admin") === "admin"
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
                {expanded && (
                  <>
                    {otherSpaces > 0 && (
                      <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                        <Info size={12} className="shrink-0 mt-px" />
                        {t("notes.spaces.teamsMembers.affectsOtherSpaces", {
                          count: otherSpaces,
                          team: teamRef.name,
                        })}
                      </p>
                    )}
                    {(teamRef.access ?? "admin") === "member" && (
                      <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                        <Info size={12} className="shrink-0 mt-px" />
                        {t("notes.spaces.teamsMembers.accessHint", { team: teamRef.name })}
                      </p>
                    )}
                    <TeamRosterSection
                      teamId={teamRef.id}
                      teamName={teamRef.name}
                      canManage={canManageTeamRoster(teamRef.my_role, workspace?.role ?? null)}
                      workspaceMembers={roster}
                      currentUserId={user?.id}
                      onInvite={
                        canInviteToWorkspace
                          ? (email) => {
                              setInviteEmail(email);
                              setInviteTeamId(teamRef.id);
                              setInviteOpen(true);
                            }
                          : undefined
                      }
                      removeConfirm={confirmRemoveMember}
                    />
                  </>
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
                          {team.name}
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
                    {showAssignSpinner && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
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
                  <Plus size={12} className="mr-1" />
                  {t("notes.spaces.teams.newTeam")}
                </Button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {space.workspace_id && (
        <CreateTeamDialog
          workspaceId={space.workspace_id}
          open={newTeamOpen}
          onOpenChange={setNewTeamOpen}
          onCreated={handleTeamCreated}
        />
      )}

      {workspace && inviteTeamId && (
        <InviteTeammateDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          teamIds={[inviteTeamId]}
          initialEmail={inviteEmail}
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
