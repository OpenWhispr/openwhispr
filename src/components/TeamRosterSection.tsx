import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Mail, X } from "lucide-react";
import { Button } from "./ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select";
import { useToast } from "./ui/useToast";
import { cn } from "./lib/utils";
import MemberAvatar from "./MemberAvatar";
import MemberPickList from "./MemberPickList";
import RoleBadge from "./RoleBadge";
import { TeamsService } from "../services/TeamsService";
import { addTeamMembers, removeTeamMember, setTeamMemberRole } from "../services/spaceActions";
import type { TeamMember, TeamRole, WorkspaceMember } from "../types/electron";

interface TeamRosterSectionProps {
  teamId: string;
  canManage: boolean;
  /** Workspace roster: the add-people candidate pool. */
  workspaceMembers: WorkspaceMember[];
  currentUserId?: string;
  /** Shown when typing an unknown email in the add search (invite affordance). */
  onInvite?: (email: string) => void;
  /** Called with the fresh roster after every load/mutation. */
  onRosterChange?: (members: TeamMember[]) => void;
  removeConfirm: (member: TeamMember, onConfirm: () => void) => void;
}

export default function TeamRosterSection({
  teamId,
  canManage,
  workspaceMembers,
  currentUserId,
  onInvite,
  onRosterChange,
  removeConfirm,
}: TeamRosterSectionProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyUserIds, setBusyUserIds] = useState<Set<string>>(new Set());
  const [addSearch, setAddSearch] = useState("");

  const loadRoster = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const list = await TeamsService.listMembers(teamId);
      setMembers(list);
      onRosterChange?.(list);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [teamId, onRosterChange]);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  const withRowBusy = useCallback(
    async (userId: string, action: () => Promise<void>) => {
      setBusyUserIds((prev) => new Set(prev).add(userId));
      try {
        await action();
        await loadRoster();
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
    [toast, t, loadRoster]
  );

  const handleRoleChange = (member: TeamMember, role: TeamRole) => {
    if (role === member.role) return;
    void withRowBusy(member.user_id, () => setTeamMemberRole(teamId, member.user_id, role));
  };

  const handleAdd = (userId: string) => {
    void withRowBusy(userId, async () => {
      const { failures } = await addTeamMembers(teamId, [userId]);
      if (failures.length > 0) throw failures[0];
    });
  };

  const memberIds = useMemo(() => new Set(members.map((m) => m.user_id)), [members]);
  const addCandidates = useMemo(() => {
    const query = addSearch.trim().toLowerCase();
    return workspaceMembers.filter(
      (m) =>
        m.user_id !== currentUserId &&
        !memberIds.has(m.user_id) &&
        (!query ||
          (m.name ?? "").toLowerCase().includes(query) ||
          m.email.toLowerCase().includes(query))
    );
  }, [workspaceMembers, memberIds, addSearch, currentUserId]);

  const searchEmail = addSearch.trim().toLowerCase();
  const showInviteFooter =
    !!onInvite &&
    searchEmail.includes("@") &&
    addCandidates.length === 0 &&
    !members.some((m) => m.email.toLowerCase() === searchEmail) &&
    !workspaceMembers.some((m) => m.email.toLowerCase() === searchEmail);

  return (
    <div className="space-y-2">
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
            const isSelf = member.user_id === currentUserId;
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
                      onClick={() =>
                        removeConfirm(member, () =>
                          void withRowBusy(member.user_id, () =>
                            removeTeamMember(teamId, member.user_id)
                          )
                        )
                      }
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
                  onClick={() => {
                    onInvite?.(addSearch.trim());
                    setAddSearch("");
                  }}
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
    </div>
  );
}
