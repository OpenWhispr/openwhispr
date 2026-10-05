import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "./ui/useToast";
import MemberRoster from "./MemberRoster";
import { useMemberRoster } from "../hooks/useMemberRoster";
import { orderMemberCandidates } from "../lib/memberCandidates";
import { TeamsService } from "../services/TeamsService";
import { addTeamMembers, removeTeamMember, setTeamMemberRole } from "../services/spaceActions";
import type { TeamMember, TeamRole, WorkspaceMember } from "../types/electron";

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

// Team-backed MemberRoster: every row is a direct team membership.
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

  const load = useCallback(async () => {
    const list = await TeamsService.listMembers(teamId);
    onRosterChange?.(list);
    return list;
  }, [teamId, onRosterChange]);
  const { members, loading, loadFailed, reload, busyIds, mutate } = useMemberRoster(load);

  const handleRoleChange = (member: TeamMember, role: TeamRole) => {
    void mutate(member.user_id, async () => {
      await setTeamMemberRole(teamId, member.user_id, role);
      toast({ title: t("notes.spaces.members.roleUpdated") });
    });
  };

  const handleAdd = (member: WorkspaceMember) => {
    void mutate(member.user_id, async () => {
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

  const handleRemove = (member: TeamMember) => {
    removeConfirm(
      member,
      () =>
        void mutate(member.user_id, async () => {
          await removeTeamMember(teamId, member.user_id);
          toast({
            title: t("notes.spaces.members.removedFromTeam", {
              name: member.name || member.email,
              team: teamName,
            }),
          });
        })
    );
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

  return (
    <MemberRoster
      members={members}
      loading={loading}
      loadFailed={loadFailed}
      onRetry={() => void reload()}
      currentUserId={currentUserId}
      canManage={canManage}
      busyIds={busyIds}
      onRoleChange={handleRoleChange}
      onRemove={handleRemove}
      addCandidates={addCandidates}
      onAdd={handleAdd}
      onInvite={onInvite}
    />
  );
}
