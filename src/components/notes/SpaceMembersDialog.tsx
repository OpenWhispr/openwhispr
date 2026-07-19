import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, LogOut, Mail, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, ConfirmDialog } from "../ui/dialog";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../ui/select";
import { useToast } from "../ui/useToast";
import { useDialogs } from "../../hooks/useDialogs";
import { useAuth } from "../../hooks/useAuth";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { cn } from "../lib/utils";
import InviteTeammateDialog from "../InviteTeammateDialog";
import MemberAvatar from "../MemberAvatar";
import MemberPickList from "../MemberPickList";
import RoleBadge from "../RoleBadge";
import { TeamsService } from "../../services/TeamsService";
import {
  addMembers,
  leaveTeamSpace,
  removeMember,
  setMemberRole,
} from "../../services/teamSpaceActions";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { canManageSpace } from "../../lib/spacePermissions";
import type { SpaceItem, TeamMember, TeamRole } from "../../types/electron";

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
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === space.workspace_id));
  const roster = useWorkspaceStore((s) => s.members);
  const refreshMembers = useWorkspaceStore((s) => s.refreshMembers);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyUserIds, setBusyUserIds] = useState<Set<string>>(new Set());
  const [isLeaving, setIsLeaving] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const showLeaveSpinner = useDelayedFlag(isLeaving);

  const teamId = space.cloud_team_id;
  const canManage = canManageSpace(space, workspace?.role ?? null);
  const canInviteToWorkspace = workspace?.role === "owner" || workspace?.role === "admin";
  // Workspace owners/admins access every team implicitly (no team_members
  // row): the server's member DELETE no-ops (or leaves implicit access
  // intact), so the space would resurrect on the next sync pass right after
  // a local purge — Leave is hidden for them (plan §4), same as in the tree.
  const isImplicitAdmin = workspace?.role === "owner" || workspace?.role === "admin";
  const isExplicitMember = members.some((m) => m.user_id === user?.id);
  const canLeave = isExplicitMember && !isImplicitAdmin;

  const loadRoster = useCallback(async () => {
    if (!teamId) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      const list = await TeamsService.listMembers(teamId);
      setMembers(list);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    if (!open) {
      setMembers([]);
      setAddSearch("");
      setBusyUserIds(new Set());
      return;
    }
    void loadRoster();
    if (space.workspace_id) void refreshMembers(space.workspace_id).catch(() => {});
  }, [open, loadRoster, space.workspace_id, refreshMembers]);

  const withRowBusy = useCallback(
    async (userId: string, action: () => Promise<TeamMember[]>) => {
      setBusyUserIds((prev) => new Set(prev).add(userId));
      try {
        setMembers(await action());
      } catch (err) {
        toast({
          title: t("common.error"),
          description: err instanceof Error ? err.message : t("common.unknownError"),
          variant: "destructive",
        });
      } finally {
        setBusyUserIds((prev) => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
      }
    },
    [toast, t]
  );

  const handleRoleChange = (member: TeamMember, role: TeamRole) => {
    if (role === member.role) return;
    void withRowBusy(member.user_id, () => setMemberRole(space, member.user_id, role));
  };

  const confirmRemove = (member: TeamMember) => {
    showConfirmDialog({
      title: t("notes.spaces.members.removeConfirm", {
        name: member.name || member.email,
        space: space.name,
      }),
      description: t("notes.spaces.members.removeConfirmDescription"),
      confirmText: t("notes.spaces.members.remove"),
      variant: "destructive",
      onConfirm: () =>
        void withRowBusy(member.user_id, () => removeMember(space, member.user_id)),
    });
  };

  const handleAdd = (userId: string) => {
    void withRowBusy(userId, async () => {
      const { roster: fresh, failures } = await addMembers(space, [userId]);
      if (failures.length > 0) throw failures[0];
      return fresh;
    });
  };

  const confirmLeave = () => {
    if (!canLeave || !user?.id) return;
    const userId = user.id;
    showConfirmDialog({
      title: t("notes.spaces.members.leaveConfirm", { space: space.name }),
      description: t("notes.spaces.members.leaveConfirmDescription"),
      confirmText: t("notes.spaces.members.leave"),
      variant: "destructive",
      onConfirm: async () => {
        setIsLeaving(true);
        try {
          if ((await leaveTeamSpace(space, userId)) === "implicit") {
            toast({ title: t("notes.spaces.members.implicitAdminCannotLeave") });
            return;
          }
          onOpenChange(false);
        } catch (err) {
          // Server rejected the leave — surface its message.
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

  const memberIds = useMemo(() => new Set(members.map((m) => m.user_id)), [members]);
  const addCandidates = useMemo(() => {
    const query = addSearch.trim().toLowerCase();
    return roster.filter(
      (m) =>
        m.user_id !== user?.id &&
        !memberIds.has(m.user_id) &&
        (!query ||
          (m.name ?? "").toLowerCase().includes(query) ||
          m.email.toLowerCase().includes(query))
    );
  }, [roster, memberIds, addSearch, user?.id]);

  const searchEmail = addSearch.trim().toLowerCase();
  const showInviteFooter =
    canInviteToWorkspace &&
    searchEmail.includes("@") &&
    addCandidates.length === 0 &&
    !members.some((m) => m.email.toLowerCase() === searchEmail) &&
    !roster.some((m) => m.email.toLowerCase() === searchEmail);

  if (!teamId) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("notes.spaces.members.title", { space: space.name })}</DialogTitle>
          </DialogHeader>

          {loading && members.length === 0 ? (
            <div className="h-24 rounded-lg bg-foreground/5 dark:bg-white/5 animate-pulse" />
          ) : loadFailed && members.length === 0 ? (
            <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 px-4 py-6 flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {t("settingsPage.workspace.members.loadError")}
              </p>
              <Button variant="outline" size="sm" onClick={() => void loadRoster()}>
                {t("settingsPage.workspace.loadError.retry")}
              </Button>
            </div>
          ) : (
            <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 divide-y divide-border/30 dark:divide-border-subtle/50 bg-card/50 dark:bg-surface-2/50 max-h-64 overflow-y-auto">
              {members.map((member) => {
                const isSelf = member.user_id === user?.id;
                const isBusy = busyUserIds.has(member.user_id);
                return (
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
                    {canManage && !isSelf ? (
                      <>
                        <Select
                          value={member.role}
                          disabled={isBusy}
                          onValueChange={(role) => handleRoleChange(member, role as TeamRole)}
                        >
                          <SelectTrigger className="h-7 w-25 px-2 text-xs rounded-md shrink-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin" className="text-xs">
                              {t("notes.spaces.members.roleAdmin")}
                            </SelectItem>
                            <SelectItem value="member" className="text-xs">
                              {t("notes.spaces.members.roleMember")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <button
                          type="button"
                          onClick={() => confirmRemove(member)}
                          disabled={isBusy}
                          aria-label={t("notes.spaces.members.remove")}
                          className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/8 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-primary/30 disabled:pointer-events-none"
                        >
                          {isBusy ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <X className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </>
                    ) : (
                      <RoleBadge
                        label={
                          member.role === "admin"
                            ? t("notes.spaces.members.roleAdmin")
                            : t("notes.spaces.members.roleMember")
                        }
                      />
                    )}
                  </div>
                );
              })}
              {members.length === 0 && (
                <div className="py-8 text-center text-xs text-muted-foreground">
                  {t("notes.spaces.members.empty")}
                </div>
              )}
            </div>
          )}

          {canManage && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground/50">
                {t("notes.spaces.members.addPeople")}
              </label>
              <MemberPickList
                members={addCandidates}
                search={addSearch}
                onSearchChange={setAddSearch}
                onSelect={(candidate) => handleAdd(candidate.user_id)}
                busyIds={busyUserIds}
                listClassName="max-h-32"
                footer={
                  showInviteFooter ? (
                    <button
                      type="button"
                      onClick={() => setInviteOpen(true)}
                      className={cn(
                        "flex items-center gap-2 w-full px-2 h-8 rounded-md text-left",
                        "transition-colors duration-150 outline-none",
                        "text-primary/80 hover:text-primary hover:bg-primary/8",
                        "focus-visible:ring-1 focus-visible:ring-ring/30"
                      )}
                    >
                      <Mail size={12} className="shrink-0" />
                      <span className="text-xs truncate">
                        {t("notes.spaces.members.inviteFooter", { email: addSearch.trim() })}
                      </span>
                    </button>
                  ) : undefined
                }
              />
            </div>
          )}

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
              {t("notes.spaces.members.leave")}
            </button>
          )}
        </DialogContent>
      </Dialog>

      {workspace && (
        <InviteTeammateDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          teamIds={[teamId]}
          initialEmail={searchEmail.includes("@") ? addSearch.trim() : undefined}
          onInvited={() => setAddSearch("")}
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
