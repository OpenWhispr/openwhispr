import React, { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Trash2, MoreVertical, Mail, X, Loader2 } from "lucide-react";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { WorkspacesService } from "../../services/WorkspacesService";
import { InvitationsService } from "../../services/InvitationsService";
import { useDialogs } from "../../hooks/useDialogs";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/dialog";
import { useToast } from "../ui/useToast";
import type { Workspace, WorkspaceInvitation, WorkspaceMember } from "../../types/electron";
import InviteTeammateDialog from "../InviteTeammateDialog";
import MemberAvatar from "../MemberAvatar";
import RoleBadge from "../RoleBadge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";

interface Props {
  workspace: Workspace;
  onNavigateToBilling: () => void;
}

function invitationDaysLeft(inv: WorkspaceInvitation): number {
  return Math.ceil((new Date(inv.expires_at).getTime() - Date.now()) / 86_400_000);
}

export default function WorkspaceMembersTab({ workspace, onNavigateToBilling }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const { members, refreshMembers, refresh } = useWorkspaceStore(
    useShallow((s) => ({
      members: s.members,
      refreshMembers: s.refreshMembers,
      refresh: s.refresh,
    }))
  );
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState(false);
  const [invitationsError, setInvitationsError] = useState(false);
  const canManage = workspace.role === "owner" || workspace.role === "admin";

  async function loadMembers() {
    setMembersLoading(true);
    setMembersError(false);
    try {
      await refreshMembers(workspace.id);
    } catch {
      setMembersError(true);
    } finally {
      setMembersLoading(false);
    }
  }

  async function refreshInvitations() {
    setInvitationsError(false);
    try {
      const list = await InvitationsService.list(workspace.id);
      setInvitations(list);
    } catch {
      setInvitations([]);
      setInvitationsError(true);
    }
  }

  useEffect(() => {
    void loadMembers();
    if (canManage) void refreshInvitations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  async function handleRoleChange(userId: string, role: "owner" | "admin" | "member") {
    try {
      await WorkspacesService.updateMemberRole(workspace.id, userId, role);
      await refreshMembers(workspace.id);
      // Ownership transfer demotes the caller — refresh so workspace.role updates everywhere.
      if (role === "owner") await refresh();
      toast({
        title: t("settingsPage.workspace.members.roleUpdated"),
      });
    } catch (error) {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    }
  }

  function confirmTransferOwnership(member: WorkspaceMember) {
    showConfirmDialog({
      title: t("settingsPage.workspace.members.transferConfirm.title"),
      description: t("settingsPage.workspace.members.transferConfirm.description", {
        name: member.name || member.email,
        workspace: workspace.name,
      }),
      confirmText: t("settingsPage.workspace.members.transferOwnership"),
      variant: "destructive",
      onConfirm: () => void handleRoleChange(member.user_id, "owner"),
    });
  }

  function confirmRemoveMember(member: WorkspaceMember) {
    showConfirmDialog({
      title: t("settingsPage.workspace.members.removeConfirm.title"),
      description: t("settingsPage.workspace.members.removeConfirm.description", {
        name: member.name || member.email,
        workspace: workspace.name,
      }),
      confirmText: t("settingsPage.workspace.members.remove"),
      variant: "destructive",
      onConfirm: async () => {
        try {
          await WorkspacesService.removeMember(workspace.id, member.user_id);
          await refreshMembers(workspace.id);
        } catch (error) {
          toast({
            title: t("common.error"),
            description: error instanceof Error ? error.message : t("common.unknownError"),
            variant: "destructive",
          });
        }
      },
    });
  }

  function confirmRevokeInvitation(inv: WorkspaceInvitation) {
    showConfirmDialog({
      title: t("settingsPage.workspace.invites.revokeConfirm.title"),
      description: t("settingsPage.workspace.invites.revokeConfirm.description", {
        email: inv.email,
      }),
      confirmText: t("settingsPage.workspace.invites.revoke"),
      variant: "destructive",
      onConfirm: async () => {
        try {
          await InvitationsService.revoke(workspace.id, inv.id);
          await refreshInvitations();
        } catch (error) {
          toast({
            title: t("settingsPage.workspace.invites.revokeFailed"),
            description: error instanceof Error ? error.message : t("common.unknownError"),
            variant: "destructive",
          });
        }
      },
    });
  }

  async function handleResend(inviteId: string) {
    setResendingId(inviteId);
    try {
      await InvitationsService.resend(workspace.id, inviteId);
      await refreshInvitations();
      toast({ title: t("settingsPage.workspace.invites.resent") });
    } catch (error) {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setResendingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold text-foreground">
            {t("settingsPage.workspace.members.title")}
          </h3>
          <p className="text-xs text-muted-foreground/80 mt-0.5">
            {t("settingsPage.workspace.members.description", {
              count: members.length,
              seats: workspace.seats,
            })}
          </p>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setInviteOpen(true)}>
            <Mail className="mr-1.5 h-3.5 w-3.5" />
            {t("settingsPage.workspace.members.invite")}
          </Button>
        )}
      </div>

      {membersLoading && members.length === 0 ? (
        <div className="h-24 rounded-lg bg-foreground/5 dark:bg-white/5 animate-pulse" />
      ) : membersError && members.length === 0 ? (
        <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 px-4 py-6 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {t("settingsPage.workspace.members.loadError")}
          </p>
          <Button variant="outline" size="sm" onClick={() => void loadMembers()}>
            {t("settingsPage.workspace.loadError.retry")}
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 divide-y divide-border/30 dark:divide-border-subtle/50 bg-card/50 dark:bg-surface-2/50">
          {members.map((member) => (
            <div key={member.user_id} className="flex items-center gap-3 px-4 h-14">
              <MemberAvatar name={member.name} email={member.email} image={member.image} />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-foreground truncate">
                  {member.name || member.email}
                </p>
                {member.name && (
                  <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                )}
              </div>
              <RoleBadge
                label={t(`settingsPage.workspace.role.${member.role}`)}
                highlight={member.role === "owner"}
              />
              {canManage && member.role !== "owner" && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5 outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
                    aria-label={t("common.actions")}
                  >
                    <MoreVertical className="w-3.5 h-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="text-xs">
                    {member.role !== "admin" && (
                      <DropdownMenuItem onSelect={() => handleRoleChange(member.user_id, "admin")}>
                        {t("settingsPage.workspace.members.promote")}
                      </DropdownMenuItem>
                    )}
                    {member.role !== "member" && (
                      <DropdownMenuItem onSelect={() => handleRoleChange(member.user_id, "member")}>
                        {t("settingsPage.workspace.members.demote")}
                      </DropdownMenuItem>
                    )}
                    {workspace.role === "owner" && (
                      <DropdownMenuItem onSelect={() => confirmTransferOwnership(member)}>
                        {t("settingsPage.workspace.members.transferOwnership")}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      className="text-destructive"
                      onSelect={() => confirmRemoveMember(member)}
                    >
                      <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                      {t("settingsPage.workspace.members.remove")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          ))}
          {members.length === 0 && (
            <div className="py-8 text-center text-xs text-muted-foreground">
              {t("settingsPage.workspace.members.empty")}
            </div>
          )}
        </div>
      )}

      {canManage && invitationsError && (
        <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 px-4 py-3 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {t("settingsPage.workspace.invites.loadError")}
          </p>
          <Button variant="outline" size="sm" onClick={() => void refreshInvitations()}>
            {t("settingsPage.workspace.loadError.retry")}
          </Button>
        </div>
      )}

      {canManage && invitations.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-foreground mb-2">
            {t("settingsPage.workspace.invites.title")}
          </h4>
          <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 divide-y divide-border/30 dark:divide-border-subtle/50 bg-card/50 dark:bg-surface-2/50">
            {invitations.map((inv) => {
              const daysLeft = invitationDaysLeft(inv);
              const expired = daysLeft <= 0;
              return (
                <div
                  key={inv.id}
                  className={cn("flex items-center gap-3 px-4 h-12", expired && "opacity-60")}
                >
                  <Mail className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-foreground truncate">{inv.email}</p>
                    <p
                      className={cn(
                        "text-[11px]",
                        expired ? "text-destructive" : "text-muted-foreground"
                      )}
                    >
                      {expired
                        ? t("settingsPage.workspace.invites.expired")
                        : t("settingsPage.workspace.invites.expiresIn", { count: daysLeft })}
                    </p>
                  </div>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {t(`settingsPage.workspace.role.${inv.workspace_role}`)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleResend(inv.id)}
                    disabled={resendingId === inv.id}
                    className="h-7 px-2"
                  >
                    {resendingId === inv.id && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                    {resendingId === inv.id
                      ? t("settingsPage.workspace.invites.resending")
                      : t("settingsPage.workspace.invites.resend")}
                  </Button>
                  <button
                    type="button"
                    onClick={() => confirmRevokeInvitation(inv)}
                    aria-label={t("settingsPage.workspace.invites.revoke")}
                    className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/8 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <InviteTeammateDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        onInvited={refreshInvitations}
        onNavigateToBilling={onNavigateToBilling}
      />

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
    </div>
  );
}
