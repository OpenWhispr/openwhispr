import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "../icons";
import { ConfirmDialog } from "../ui/dialog";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "../ui/BidiInterpolatedText";
import { useDialogs } from "../../hooks/useDialogs";
import { useAuth } from "../../hooks/useAuth";
import { useMemberRoster } from "../../hooks/useMemberRoster";
import { cn } from "../lib/utils";
import InviteTeammateDialog from "../InviteTeammateDialog";
import MemberRoster from "../MemberRoster";
import SpaceGroupsSection from "./SpaceGroupsSection";
import { SpacesService, type SpaceMemberEntry } from "../../services/SpacesService";
import {
  addSpaceMembers,
  removeSpaceMember,
  setSpaceMemberRole,
} from "../../services/spaceActions";
import { useToast } from "../ui/useToast";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { formatList } from "../../lib/formatList";
import { orderMemberCandidates } from "../../lib/memberCandidates";
import { canManageSpace, canManageWorkspace } from "../../lib/spacePermissions";
import type { SpaceItem, TeamRole, WorkspaceMember } from "../../types/electron";

interface SpaceMembersPanelProps {
  space: SpaceItem;
}

// Everyone with access to a space — added directly or through a group — as
// one flat list, with group assignment tucked into a disclosure below.
// Rendered inside SpaceSettingsDialog's Members tab.
export default function SpaceMembersPanel({ space }: SpaceMembersPanelProps) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
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
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState<string | undefined>(undefined);
  // Invitees don't appear in the roster until they accept, so the last sent
  // invite stays visible under the add block.
  const [invitedEmail, setInvitedEmail] = useState<string | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);

  const canManage = canManageSpace(space, workspace?.role ?? null);
  // Workspace invites are 403'd below workspace admin.
  const isWorkspaceAdmin = canManageWorkspace(workspace?.role);
  const spaceId = space.cloud_space_id;

  const load = useCallback(
    () => (spaceId ? SpacesService.listMembers(spaceId) : Promise.resolve<SpaceMemberEntry[]>([])),
    [spaceId]
  );
  const { members, loading, loadFailed, reload, busyIds, mutate } = useMemberRoster(load);

  useEffect(() => {
    if (space.workspace_id) void refreshMembers(space.workspace_id).catch(() => {});
  }, [space.workspace_id, refreshMembers]);

  const rows = useMemo(
    () =>
      members.map((m) => ({
        ...m,
        via: m.via_teams.map((team) => team.name),
        adminVia: m.via_teams
          .filter((team) => team.role === "admin" && team.access === "admin")
          .map((team) => team.name),
      })),
    [members]
  );

  const memberIds = useMemo(() => new Set(members.map((m) => m.user_id)), [members]);
  const addCandidates = useMemo(
    () =>
      orderMemberCandidates(
        roster.filter((member) => !memberIds.has(member.user_id)),
        user?.id
      ),
    [roster, memberIds, user?.id]
  );

  const handleRoleChange = (member: SpaceMemberEntry, role: TeamRole) => {
    void mutate(member.user_id, async () => {
      await setSpaceMemberRole(space, member.user_id, role);
      toast({ title: t("notes.spaces.members.roleUpdated") });
    });
  };

  const handleAdd = (member: WorkspaceMember) => {
    void mutate(member.user_id, async () => {
      const { failures } = await addSpaceMembers(space, [member.user_id]);
      if (failures.length > 0) throw failures[0];
      toast({
        title: t("notes.spaces.members.addedToTeam", {
          name: member.name || member.email,
          team: space.name,
        }),
      });
    });
  };

  // Removing drops the direct grant only; access through a group stays and
  // is said so up front and after the fact.
  const handleRemove = (member: SpaceMemberEntry) => {
    const name = member.name || member.email;
    const groupNames = (teams: { name: string }[]) =>
      formatList(
        i18n.language,
        teams.map((team) => team.name)
      );
    showConfirmDialog({
      title: t("notes.spaces.members.removeConfirm", { name, space: space.name }),
      description:
        member.via_teams.length > 0
          ? t("notes.spaces.members.removeKeepsGroupAccess", {
              groups: groupNames(member.via_teams),
            })
          : t("notes.spaces.members.removeConfirmDescription"),
      confirmText: t("notes.spaces.members.remove"),
      variant: "destructive",
      onConfirm: () =>
        void mutate(member.user_id, async () => {
          const { still_via_teams } = await removeSpaceMember(space, member.user_id);
          toast({
            title:
              still_via_teams.length > 0
                ? t("notes.spaces.members.stillViaGroups", {
                    name,
                    groups: groupNames(still_via_teams),
                  })
                : t("notes.spaces.members.removedFromTeam", { name, team: space.name }),
          });
        }),
    });
  };

  if (!spaceId) return null;

  return (
    <>
      <div className="space-y-4">
        <MemberRoster
          members={rows}
          loading={loading}
          loadFailed={loadFailed}
          onRetry={() => void reload()}
          currentUserId={user?.id}
          canManage={canManage}
          busyIds={busyIds}
          onRoleChange={handleRoleChange}
          onRemove={handleRemove}
          addCandidates={addCandidates}
          onAdd={handleAdd}
          onInvite={
            isWorkspaceAdmin
              ? (email) => {
                  setInviteEmail(email);
                  setInviteOpen(true);
                }
              : undefined
          }
        />

        {invitedEmail && (
          <p className="text-[11px] text-muted-foreground">
            <BidiInterpolatedText
              text={t("notes.spaces.members.invited", { email: BIDI_VALUE_TOKEN })}
              value={invitedEmail}
            />
          </p>
        )}

        <div className="space-y-2">
          <div className="-mx-1">
            <button
              type="button"
              aria-expanded={groupsOpen}
              onClick={() => setGroupsOpen((open) => !open)}
              className={cn(
                "flex w-full min-w-0 items-center gap-1.5 h-8 px-1.5 rounded-md",
                "transition-colors duration-150 outline-none",
                "hover:bg-foreground/4 dark:hover:bg-white/4",
                "focus-visible:ring-1 focus-visible:ring-ring/30"
              )}
            >
              <ChevronRight
                size={12}
                aria-hidden="true"
                className={cn(
                  "shrink-0 text-foreground/45 transition-transform duration-150",
                  groupsOpen ? "rotate-90" : "rtl:rotate-180"
                )}
              />
              <span className="text-xs font-semibold text-foreground truncate">
                {t("notes.spaces.groups.title")}
              </span>
              <span className="ms-auto text-[10px] text-foreground/45 shrink-0">
                {space.teams.length}
              </span>
            </button>
          </div>
          {groupsOpen && <SpaceGroupsSection space={space} onChanged={() => void reload()} />}
        </div>
      </div>

      {workspace && (
        <InviteTeammateDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          workspaceId={workspace.id}
          workspaceName={workspace.name}
          spaceIds={[spaceId]}
          initialEmail={inviteEmail}
          onInvited={setInvitedEmail}
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
