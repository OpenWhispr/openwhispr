import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, MoreVertical, Mail, X } from "lucide-react";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { WorkspacesService } from "../../services/WorkspacesService";
import { InvitationsService } from "../../services/InvitationsService";
import { Button } from "../ui/button";
import { useToast } from "../ui/useToast";
import type { Workspace, WorkspaceInvitation } from "../../types/electron";
import InviteTeammateDialog from "../InviteTeammateDialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";

interface Props {
  workspace: Workspace;
}

export default function WorkspaceMembersTab({ workspace }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const members = useWorkspaceStore((s) => s.members);
  const refreshMembers = useWorkspaceStore((s) => s.refreshMembers);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const canManage = workspace.role === "owner" || workspace.role === "admin";

  async function refreshInvitations() {
    try {
      const list = await InvitationsService.list(workspace.id);
      setInvitations(list);
    } catch {
      setInvitations([]);
    }
  }

  useEffect(() => {
    void refreshMembers(workspace.id);
    if (canManage) void refreshInvitations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  async function handleRoleChange(userId: string, role: "owner" | "admin" | "member") {
    try {
      await WorkspacesService.updateMemberRole(workspace.id, userId, role);
      await refreshMembers(workspace.id);
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

  async function handleRemove(userId: string) {
    try {
      await WorkspacesService.removeMember(workspace.id, userId);
      await refreshMembers(workspace.id);
    } catch (error) {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    }
  }

  async function handleRevoke(inviteId: string) {
    try {
      await InvitationsService.revoke(workspace.id, inviteId);
      await refreshInvitations();
    } catch {
      // toast handled inline
    }
  }

  async function handleResend(inviteId: string) {
    try {
      await InvitationsService.resend(workspace.id, inviteId);
      toast({ title: t("settingsPage.workspace.invites.resent") });
    } catch (error) {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
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

      <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 divide-y divide-border/30 dark:divide-border-subtle/50 bg-card/50 dark:bg-surface-2/50">
        {members.map((member) => (
          <div
            key={member.user_id}
            className="flex items-center gap-3 px-4 h-14"
          >
            {member.image ? (
              <img
                src={member.image}
                alt=""
                className="w-7 h-7 rounded-full object-cover shrink-0"
              />
            ) : (
              <span className="w-7 h-7 rounded-full bg-primary/10 text-primary text-[10px] font-semibold flex items-center justify-center shrink-0">
                {(member.name || member.email).slice(0, 2).toUpperCase()}
              </span>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground truncate">
                {member.name || member.email}
              </p>
              {member.name && (
                <p className="text-xs text-muted-foreground truncate">{member.email}</p>
              )}
            </div>
            <span
              className={cn(
                "text-[10px] font-medium px-2 py-0.5 rounded-md uppercase tracking-wide",
                member.role === "owner"
                  ? "bg-primary/10 text-primary"
                  : "bg-foreground/6 text-foreground/65"
              )}
            >
              {t(`settingsPage.workspace.role.${member.role}`)}
            </span>
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
                    <DropdownMenuItem onSelect={() => handleRoleChange(member.user_id, "owner")}>
                      {t("settingsPage.workspace.members.transferOwnership")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="text-destructive"
                    onSelect={() => handleRemove(member.user_id)}
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

      {canManage && invitations.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-foreground mb-2">
            {t("settingsPage.workspace.invites.title")}
          </h4>
          <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 divide-y divide-border/30 dark:divide-border-subtle/50 bg-card/50 dark:bg-surface-2/50">
            {invitations.map((inv) => (
              <div key={inv.id} className="flex items-center gap-3 px-4 h-12">
                <Mail className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-foreground truncate">{inv.email}</p>
                </div>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t(`settingsPage.workspace.role.${inv.workspace_role}`)}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleResend(inv.id)}
                  className="h-7 px-2"
                >
                  {t("settingsPage.workspace.invites.resend")}
                </Button>
                <button
                  type="button"
                  onClick={() => handleRevoke(inv.id)}
                  aria-label={t("settingsPage.workspace.invites.revoke")}
                  className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/8 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <InviteTeammateDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        onInvited={refreshInvitations}
      />
    </div>
  );
}
