import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Loader2, LogOut } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, ConfirmDialog } from "../ui/dialog";
import { useToast } from "../ui/useToast";
import { useDialogs } from "../../hooks/useDialogs";
import { useAuth } from "../../hooks/useAuth";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { cn } from "../lib/utils";
import InviteTeammateDialog from "../InviteTeammateDialog";
import TeamRosterSection from "../TeamRosterSection";
import { leaveTeam } from "../../services/spaceActions";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { canManageTeamRoster } from "../../lib/spacePermissions";
import type { Team, TeamMember, Workspace } from "../../types/electron";

interface TeamMembersDialogProps {
  team: Team;
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function TeamMembersDialog({
  team,
  workspace,
  open,
  onOpenChange,
}: TeamMembersDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const { members: roster, refreshMembers } = useWorkspaceStore(
    useShallow((s) => ({ members: s.members, refreshMembers: s.refreshMembers }))
  );
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [isLeaving, setIsLeaving] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState<string | undefined>(undefined);
  const showLeaveSpinner = useDelayedFlag(isLeaving);

  const isWorkspaceAdmin = workspace.role === "owner" || workspace.role === "admin";
  const myTeamRole = teamMembers.find((m) => m.user_id === user?.id)?.role ?? null;
  const canManage = canManageTeamRoster(myTeamRole, workspace.role);
  // Explicit members can leave; implicit workspace admins have no row to drop.
  const canLeave = myTeamRole !== null && !isWorkspaceAdmin;

  useEffect(() => {
    if (open) void refreshMembers(workspace.id).catch(() => {});
  }, [open, workspace.id, refreshMembers]);

  const confirmRemoveMember = useCallback(
    (member: TeamMember, onConfirm: () => void) => {
      showConfirmDialog({
        title: t("settingsPage.workspace.teams.members.removeConfirm", {
          name: member.name || member.email,
          team: team.name,
        }),
        description: t("notes.spaces.members.removeConfirmDescription"),
        confirmText: t("notes.spaces.members.remove"),
        variant: "destructive",
        onConfirm,
      });
    },
    [showConfirmDialog, t, team.name]
  );

  const confirmLeave = () => {
    if (!canLeave || !user?.id) return;
    const userId = user.id;
    showConfirmDialog({
      title: t("settingsPage.workspace.teams.members.leaveConfirm", { team: team.name }),
      description: t("settingsPage.workspace.teams.members.leaveConfirmDescription"),
      confirmText: t("settingsPage.workspace.teams.members.leave"),
      variant: "destructive",
      onConfirm: async () => {
        setIsLeaving(true);
        try {
          await leaveTeam(team.id, userId);
          onOpenChange(false);
        } catch (err) {
          toast({
            title: t("common.error"),
            description: err instanceof Error ? err.message : t("common.unknownError"),
            variant: "destructive",
          });
        } finally {
          setIsLeaving(false);
        }
      },
    });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("settingsPage.workspace.teams.members.title", { team: team.name })}
            </DialogTitle>
          </DialogHeader>

          <TeamRosterSection
            teamId={team.id}
            canManage={canManage}
            workspaceMembers={roster}
            currentUserId={user?.id}
            onInvite={
              isWorkspaceAdmin
                ? (email) => {
                    setInviteEmail(email);
                    setInviteOpen(true);
                  }
                : undefined
            }
            onRosterChange={setTeamMembers}
            removeConfirm={confirmRemoveMember}
          />

          {canLeave && (
            <button
              type="button"
              onClick={confirmLeave}
              disabled={isLeaving}
              className={cn(
                "flex items-center gap-2 w-full px-4 h-10 rounded-lg",
                "border border-border/50 dark:border-border-subtle/70",
                "text-xs font-medium text-destructive",
                "transition-colors duration-150 outline-none",
                "hover:bg-destructive/5 active:bg-destructive/8",
                "focus-visible:ring-1 focus-visible:ring-destructive/30",
                "disabled:opacity-60"
              )}
            >
              {showLeaveSpinner ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
              ) : (
                <LogOut size={13} className="shrink-0" />
              )}
              {t("settingsPage.workspace.teams.members.leave")}
            </button>
          )}
        </DialogContent>
      </Dialog>

      <InviteTeammateDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        teamIds={[team.id]}
        initialEmail={inviteEmail}
      />

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
