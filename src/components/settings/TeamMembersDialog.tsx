import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Loader2, LogOut } from "../icons";
import { Dialog, DialogContent, DialogHeader, DialogTitle, ConfirmDialog } from "../ui/dialog";
import { useToast } from "../ui/useToast";
import { useDialogs } from "../../hooks/useDialogs";
import { useAuth } from "../../hooks/useAuth";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { useDialogSession } from "../../hooks/useDialogSession";
import { cn } from "../lib/utils";
import InviteTeammateDialog from "../InviteTeammateDialog";
import TeamRosterSection from "../TeamRosterSection";
import { leaveTeam } from "../../services/spaceActions";
import { useWorkspaceStore, EMPTY_WORKSPACE_MEMBERS } from "../../stores/workspaceStore";
import { canManageTeamRoster, canManageWorkspace } from "../../lib/spacePermissions";
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
    useShallow((s) => ({
      members: s.membersByWorkspace[workspace.id] ?? EMPTY_WORKSPACE_MEMBERS,
      refreshMembers: s.refreshMembers,
    }))
  );
  const { sessionKey, capture, invalidate, bindSession } = useDialogSession(
    open,
    JSON.stringify([workspace.id, team.id])
  );
  const [loadedRoster, setLoadedRoster] = useState<{ owner: string; members: TeamMember[] } | null>(
    null
  );
  const teamMembers = loadedRoster?.owner === sessionKey ? loadedRoster.members : [];
  const publishRoster = useCallback(
    (members: TeamMember[]) => {
      setLoadedRoster({ owner: sessionKey, members });
    },
    [sessionKey]
  );
  const [isLeaving, setIsLeaving] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState<string | undefined>(undefined);
  const showLeaveSpinner = useDelayedFlag(isLeaving);
  const [formOwner, setFormOwner] = useState(sessionKey);
  if (formOwner !== sessionKey) {
    setFormOwner(sessionKey);
    setLoadedRoster(null);
    setIsLeaving(false);
    setInviteOpen(false);
    setInviteEmail(undefined);
  }

  const isWorkspaceAdmin = canManageWorkspace(workspace.role);
  const myTeamRole = teamMembers.find((m) => m.user_id === user?.id)?.role ?? null;
  const canManage = canManageTeamRoster(myTeamRole, workspace.role);
  // Anyone with an explicit membership row can drop it — including workspace
  // admins who added themselves (their implicit admin access survives leaving).
  const canLeave = myTeamRole !== null;

  useEffect(() => {
    if (open) void refreshMembers(workspace.id).catch(() => {});
  }, [open, workspace.id, refreshMembers]);

  const confirmRemoveMember = (member: TeamMember, onConfirm: () => void) => {
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
  };

  const confirmLeave = () => {
    if (!canLeave || !user?.id) return;
    const userId = user.id;
    const completion = capture();
    showConfirmDialog({
      title: t("settingsPage.workspace.teams.members.leaveConfirm", { team: team.name }),
      description: t("settingsPage.workspace.teams.members.leaveConfirmDescription"),
      confirmText: t("settingsPage.workspace.teams.members.leave"),
      variant: "destructive",
      onConfirm: async () => {
        if (!completion.isCurrent()) return;
        setIsLeaving(true);
        try {
          await leaveTeam(team.id, userId);
          if (!completion.isCurrent()) return;
          toast({
            title: t("settingsPage.workspace.teams.members.leftTeam", { team: team.name }),
          });
          onOpenChange(false);
        } catch (err) {
          if (!completion.isCurrent()) return;
          toast({
            title: t("common.error"),
            description: err instanceof Error ? err.message : t("common.unknownError"),
            variant: "destructive",
          });
        } finally {
          if (completion.isCurrent()) setIsLeaving(false);
        }
      },
    });
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) invalidate();
          onOpenChange(next);
        }}
      >
        <DialogContent ref={bindSession} className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("settingsPage.workspace.teams.members.title", { team: team.name })}
            </DialogTitle>
          </DialogHeader>

          <TeamRosterSection
            teamId={team.id}
            teamName={team.name}
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
            onRosterChange={publishRoster}
            removeConfirm={confirmRemoveMember}
          />

          {canLeave && (
            <button
              type="button"
              onClick={confirmLeave}
              disabled={isLeaving}
              className={cn(
                "flex items-center gap-2 w-full px-4 h-10 rounded-lg",
                "border border-border/70 dark:border-border-subtle/70",
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
