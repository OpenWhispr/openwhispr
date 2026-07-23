import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Info, Plus, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, ConfirmDialog } from "../ui/dialog";
import { Select, SelectTrigger, SelectContent, SelectItem } from "../ui/select";
import { useDialogs } from "../../hooks/useDialogs";
import { useAuth } from "../../hooks/useAuth";
import InviteTeammateDialog from "../InviteTeammateDialog";
import TeamRosterSection from "../TeamRosterSection";
import { TeamsService } from "../../services/TeamsService";
import { assignTeamToSpace, unassignTeamFromSpace } from "../../services/spaceActions";
import { useToast } from "../ui/useToast";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useSpaces } from "../../stores/noteStore";
import { canManageSpace, canManageTeamRoster } from "../../lib/spacePermissions";
import type { SpaceItem, Team, TeamMember } from "../../types/electron";

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

  const canManage = canManageSpace(space, workspace?.role ?? null);
  const canInviteToWorkspace = workspace?.role === "owner" || workspace?.role === "admin";

  useEffect(() => {
    if (!open) {
      setInviteEmail(undefined);
      setInviteTeamId(null);
      return;
    }
    if (space.workspace_id) {
      void refreshMembers(space.workspace_id).catch(() => {});
      if (canManage) {
        void TeamsService.list(space.workspace_id)
          .then(setWorkspaceTeams)
          .catch(() => setWorkspaceTeams([]));
      }
    }
  }, [open, space.workspace_id, refreshMembers, canManage]);

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

  const handleAssignTeam = async (teamId: string) => {
    try {
      await assignTeamToSpace(space, teamId);
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
            return (
              <div key={teamRef.id} className="space-y-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-semibold text-foreground flex-1 truncate">
                    {teamRef.name}
                  </h3>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => confirmUnassignTeam(teamRef.id, teamRef.name)}
                      aria-label={t("notes.spaces.teamsMembers.removeTeamFromSpace")}
                      className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/8 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                {otherSpaces > 0 && (
                  <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                    <Info size={12} className="shrink-0 mt-px" />
                    {t("notes.spaces.teamsMembers.affectsOtherSpaces", {
                      count: otherSpaces,
                      team: teamRef.name,
                    })}
                  </p>
                )}
                <TeamRosterSection
                  teamId={teamRef.id}
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
              </div>
            );
          })}

          {canManage && unassignedTeams.length > 0 && (
            <Select value="" onValueChange={(teamId) => void handleAssignTeam(teamId)}>
              <SelectTrigger className="h-8 text-xs">
                <span className="flex items-center gap-1.5 text-foreground/60">
                  <Plus size={12} />
                  {t("notes.spaces.teamsMembers.addTeam")}
                </span>
              </SelectTrigger>
              <SelectContent>
                {unassignedTeams.map((team) => (
                  <SelectItem key={team.id} value={team.id} className="text-xs">
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </DialogContent>
      </Dialog>

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
