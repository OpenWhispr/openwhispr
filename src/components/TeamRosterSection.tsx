import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Loader2, Mail } from "./icons";
import { Button } from "./ui/button";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "./ui/BidiInterpolatedText";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { useToast } from "./ui/useToast";
import { cn } from "./lib/utils";
import MemberAvatar from "./MemberAvatar";
import MemberPickList from "./MemberPickList";
import RoleBadge from "./RoleBadge";
import { orderMemberCandidates } from "../lib/memberCandidates";
import { TeamsService } from "../services/TeamsService";
import { addTeamMembers, removeTeamMember, setTeamMemberRole } from "../services/spaceActions";
import type { TeamMember, TeamRole, WorkspaceMember } from "../types/electron";

const ROLES: TeamRole[] = ["admin", "member"];
const ROLE_LABEL_KEY: Record<TeamRole, string> = {
  admin: "notes.spaces.members.roleAdmin",
  member: "notes.spaces.members.roleMember",
};
const ROLE_DESCRIPTION_KEY: Record<TeamRole, string> = {
  admin: "notes.spaces.members.roleAdminDescription",
  member: "notes.spaces.members.roleMemberDescription",
};
// Quiet trigger: reads as the row's role text with a chevron, not a button.
const ROLE_TRIGGER_CLASS =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-foreground/80 outline-none transition-colors " +
  "hover:bg-foreground/5 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/30 data-[state=open]:bg-foreground/5 " +
  "disabled:opacity-60 dark:hover:bg-white/5 dark:data-[state=open]:bg-white/5";

interface TeamRosterSectionProps {
  teamId: string;
  /** Names the team in the add-people label and confirmation toasts. */
  teamName: string;
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
  teamName,
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
    void withRowBusy(member.user_id, async () => {
      await setTeamMemberRole(teamId, member.user_id, role);
      toast({ title: t("notes.spaces.members.roleUpdated") });
    });
  };

  const handleAdd = (member: WorkspaceMember) => {
    void withRowBusy(member.user_id, async () => {
      const { failures } = await addTeamMembers(teamId, [member.user_id]);
      if (failures.length > 0) throw failures[0];
      toast({
        title: t("notes.spaces.members.addedToTeam", {
          name: member.name || member.email,
          team: teamName,
        }),
      });
    });
  };

  const memberIds = useMemo(() => new Set(members.map((m) => m.user_id)), [members]);
  const addCandidates = useMemo(
    () =>
      orderMemberCandidates(
        workspaceMembers.filter((member) => !memberIds.has(member.user_id)),
        currentUserId
      ),
    [workspaceMembers, memberIds, currentUserId]
  );

  const searchEmail = addSearch.trim().toLowerCase();
  const showInviteFooter =
    !!onInvite &&
    searchEmail.includes("@") &&
    !members.some((m) => m.email.toLowerCase() === searchEmail) &&
    !workspaceMembers.some((m) => m.email.toLowerCase() === searchEmail);

  return (
    <div className="space-y-2">
      {loading && members.length === 0 ? (
        <div className="h-24 rounded-lg bg-foreground/5 dark:bg-white/5 animate-pulse" />
      ) : loadFailed && members.length === 0 ? (
        <div className="rounded-lg border border-border/70 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 px-4 py-6 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {t("settingsPage.workspace.members.loadError")}
          </p>
          <Button variant="outline" size="sm" onClick={() => void loadRoster()}>
            {t("settingsPage.workspace.loadError.retry")}
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-border/70 dark:border-border-subtle/70 divide-y divide-border/60 dark:divide-border-subtle/50 bg-card/50 dark:bg-surface-2/50 max-h-64 overflow-y-auto">
          {members.map((member) => {
            const isSelf = member.user_id === currentUserId;
            const isBusy = busyUserIds.has(member.user_id);
            return (
              <div key={member.user_id} className="flex items-center gap-3 px-4 h-14">
                <MemberAvatar name={member.name} email={member.email} image={member.image} />
                <div className="flex-1 min-w-0">
                  <p dir="auto" className="text-xs font-medium text-foreground truncate">
                    {member.name || member.email}
                  </p>
                  {member.name && (
                    <p dir="ltr" className="text-xs text-muted-foreground truncate">
                      {member.email}
                    </p>
                  )}
                </div>
                {canManage && !isSelf ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" disabled={isBusy} className={ROLE_TRIGGER_CLASS}>
                        {t(ROLE_LABEL_KEY[member.role])}
                        {isBusy ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <ChevronDown size={12} className="text-foreground/45" />
                        )}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-60">
                      {ROLES.map((role) => (
                        <DropdownMenuItem
                          key={role}
                          onClick={() => handleRoleChange(member, role)}
                          className="flex-col items-start gap-0.5 rounded-md px-2 py-1.5"
                        >
                          <span className="flex w-full items-center text-xs font-medium">
                            {t(ROLE_LABEL_KEY[role])}
                            {member.role === role && (
                              <Check size={12} className="ms-auto text-primary" />
                            )}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {t(ROLE_DESCRIPTION_KEY[role])}
                          </span>
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() =>
                          removeConfirm(
                            member,
                            () =>
                              void withRowBusy(member.user_id, async () => {
                                await removeTeamMember(teamId, member.user_id);
                                toast({
                                  title: t("notes.spaces.members.removedFromTeam", {
                                    name: member.name || member.email,
                                    team: teamName,
                                  }),
                                });
                              })
                          )
                        }
                        className="rounded-md px-2 py-1.5 text-xs text-destructive focus:bg-destructive/10 focus:text-destructive"
                      >
                        {t("notes.spaces.members.remove")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <RoleBadge label={t(ROLE_LABEL_KEY[member.role])} />
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
            revealOnFocus
            members={addCandidates}
            search={addSearch}
            onSearchChange={setAddSearch}
            onSelect={handleAdd}
            currentUserId={currentUserId}
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
                    "flex items-center gap-2 w-full px-2 h-8 rounded-md text-start",
                    "transition-colors duration-150 outline-none",
                    "text-primary/80 hover:text-primary hover:bg-primary/8",
                    "focus-visible:ring-1 focus-visible:ring-ring/30"
                  )}
                >
                  <Mail size={12} className="shrink-0" />
                  <span className="text-xs truncate">
                    <BidiInterpolatedText
                      text={t("notes.spaces.members.inviteFooter", {
                        email: BIDI_VALUE_TOKEN,
                      })}
                      value={addSearch.trim()}
                    />
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
