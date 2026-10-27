import React, { useEffect, useReducer, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Loader2 } from "../icons";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { WorkspacesService } from "../../services/WorkspacesService";
import { useAuth } from "../../hooks/useAuth";
import { Button } from "../ui/button";
import { useToast } from "../ui/useToast";
import type { Workspace, WorkspaceJoinRequest, WorkspaceMember } from "../../types/electron";
import MemberAvatar from "../MemberAvatar";
import { cn } from "../lib/utils";
import { workspaceCan } from "../../lib/capabilities";
import { confirmActionReducer } from "../../lib/confirmActionFlow";
import { membersView, rosterHasTeams, teamSummary } from "../../lib/peopleRoster";
import { classifyRowActionError } from "../../lib/workspaceErrors";
import { transferReducer } from "../../lib/workspaceTransferFlow";
import { RemoveMemberDialog } from "../workspace/RemoveMemberDialog";
import { TransferOwnershipDialog } from "../workspace/TransferOwnershipDialog";
import { MemberRoleMenu } from "./MemberRoleMenu";

interface WorkspaceMembersTabProps {
  workspace: Workspace;
  /** Filters the table by name or email. */
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
}

const TABLE_FRAME = "rounded-xl border border-border/70 dark:border-border-subtle/70";
const ROW_DIVIDER = "border-t border-border/60 dark:border-border-subtle/50";
// The header sticks over the rows on the settings pane's own background.
const HEADER_CELL =
  "sticky top-0 z-10 h-9 bg-background dark:bg-surface-1 text-xs font-normal text-muted-foreground first:rounded-ss-xl last:rounded-se-xl";
const SKELETON_ROWS = 3;

export default function WorkspaceMembersTab({
  workspace,
  searchQuery,
}: WorkspaceMembersTabProps): React.ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { members, refreshMembers } = useWorkspaceStore(
    useShallow((s) => ({
      members: s.members,
      refreshMembers: s.refreshMembers,
    }))
  );
  const [transferState, dispatchTransfer] = useReducer(transferReducer, { kind: "closed" });
  const [removeState, dispatchRemove] = useReducer(confirmActionReducer<WorkspaceMember>, {
    kind: "closed",
  });
  const [joinRequests, setJoinRequests] = useState<WorkspaceJoinRequest[]>([]);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  // The roster loads on mount, so an empty one starts out loading rather than as a table with no rows.
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState(false);
  const [pendingRoleIds, setPendingRoleIds] = useState<ReadonlySet<string>>(() => new Set());
  const canManage = workspaceCan(workspace, "manage_members");
  const canTransferOwnership = workspaceCan(workspace, "transfer_ownership");

  async function loadMembers(): Promise<void> {
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

  async function refreshJoinRequests(): Promise<void> {
    try {
      setJoinRequests(await WorkspacesService.listJoinRequests(workspace.id));
    } catch {
      // Requests are additive context; a failure here must not break the tab.
      setJoinRequests([]);
    }
  }

  async function decideJoinRequest(
    request: WorkspaceJoinRequest,
    decision: "approve" | "deny"
  ): Promise<void> {
    setDecidingId(request.id);
    try {
      await WorkspacesService.decideJoinRequest(workspace.id, request.id, decision);
      setJoinRequests((current) => current.filter((r) => r.id !== request.id));
      if (decision === "approve") await loadMembers();
      toast({
        title:
          decision === "approve"
            ? t("settingsPage.workspace.joinRequests.approved", {
                name: request.name ?? request.email,
              })
            : t("settingsPage.workspace.joinRequests.denied"),
      });
    } catch (error) {
      toast({
        title: t("settingsPage.workspace.joinRequests.errorTitle"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setDecidingId(null);
    }
  }

  useEffect(() => {
    void loadMembers();
    if (canManage) void refreshJoinRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  function setRolePending(userId: string, pending: boolean): void {
    setPendingRoleIds((current) => {
      const next = new Set(current);
      if (pending) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }

  async function handleRoleChange(
    member: WorkspaceMember,
    role: "admin" | "member"
  ): Promise<void> {
    const name = member.name || member.email;
    setRolePending(member.user_id, true);
    try {
      await WorkspacesService.updateMemberRole(workspace.id, member.user_id, role);
    } catch (error) {
      setRolePending(member.user_id, false);
      const failure = classifyRowActionError(error);
      toast({
        title: t("common.error"),
        description:
          failure.kind === "refused"
            ? failure.message
            : failure.kind === "gone"
              ? t("workspaces.removeMember.alreadyRemoved", { name })
              : t("settingsPage.workspace.people.roleFailed", { name }),
        variant: "destructive",
      });
      if (failure.kind === "gone") void loadMembers();
      return;
    }
    // The role has changed by now, so a failed re-read (the store logs it) keeps the cached
    // roster rather than reporting the change as failed.
    await refreshMembers(workspace.id).catch(() => undefined);
    setRolePending(member.user_id, false);
    toast({ title: t("settingsPage.workspace.members.roleUpdated") });
  }

  const view = membersView({
    loading: membersLoading,
    error: membersError,
    members,
    query: searchQuery,
  });
  const showTeams = rosterHasTeams(members);

  return (
    <div className="space-y-4">
      {canManage && joinRequests.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-foreground mb-2">
            {t("settingsPage.workspace.joinRequests.title")}
          </h4>
          <div className="rounded-lg border border-border/70 dark:border-border-subtle/70 divide-y divide-border/60 dark:divide-border-subtle/50 bg-card/50 dark:bg-surface-2/50">
            {joinRequests.map((request) => (
              <div key={request.id} className="flex items-center gap-3 px-4 h-12">
                <MemberAvatar
                  name={request.name}
                  email={request.email}
                  image={request.image}
                  size="sm"
                />
                <div className="flex-1 min-w-0">
                  <p dir="auto" className="text-xs text-foreground truncate">
                    {request.name ?? request.email}
                  </p>
                  {request.name && (
                    <p className="text-[11px] text-muted-foreground truncate">
                      <bdi dir="ltr">{request.email}</bdi>
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void decideJoinRequest(request, "deny")}
                    disabled={decidingId !== null}
                  >
                    {t("settingsPage.workspace.joinRequests.deny")}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void decideJoinRequest(request, "approve")}
                    disabled={decidingId !== null}
                  >
                    {decidingId === request.id && (
                      <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />
                    )}
                    {t("settingsPage.workspace.joinRequests.approve")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {canManage && (
        <div className="flex items-center justify-end gap-3">
          <p className="text-xs text-muted-foreground/80">
            {t("settingsPage.workspace.members.description", {
              count: members.length,
              seats: workspace.seats,
            })}
          </p>
        </div>
      )}

      {view.kind === "loading" && (
        <div className={TABLE_FRAME}>
          {Array.from({ length: SKELETON_ROWS }, (_, index) => (
            <div
              key={index}
              aria-hidden="true"
              className={cn("flex h-14 items-center gap-3 px-4", index > 0 && ROW_DIVIDER)}
            >
              <div className="size-7 shrink-0 rounded-full bg-foreground/5 dark:bg-white/5 animate-pulse" />
              <div className="space-y-1.5">
                <div className="h-2.5 w-28 rounded bg-foreground/5 dark:bg-white/5 animate-pulse" />
                <div className="h-2 w-40 rounded bg-foreground/5 dark:bg-white/5 animate-pulse" />
              </div>
            </div>
          ))}
          <div role="status" className={cn("px-4 py-5 text-center", ROW_DIVIDER)}>
            <p className="text-xs font-medium text-foreground">
              {t("settingsPage.workspace.people.loading.title")}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t("settingsPage.workspace.people.loading.body")}
            </p>
          </div>
        </div>
      )}

      {view.kind === "failed" && (
        <div className={cn(TABLE_FRAME, "px-4 py-8 text-center")}>
          <p className="text-xs font-medium text-foreground">
            {t("settingsPage.workspace.people.failed.title")}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("settingsPage.workspace.people.failed.body")}
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void loadMembers()}>
            {t("workspaces.exit.tryAgain")}
          </Button>
        </div>
      )}

      {view.kind === "rows" && (
        <div className={TABLE_FRAME}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th scope="col" className={cn(HEADER_CELL, "ps-4 pe-3 text-start")}>
                  {t("settingsPage.workspace.people.columns.name")}
                </th>
                {showTeams && (
                  <th scope="col" className={cn(HEADER_CELL, "px-3 text-start")}>
                    {t("settingsPage.workspace.people.columns.team")}
                  </th>
                )}
                <th scope="col" className={cn(HEADER_CELL, "ps-3 pe-4 text-end")}>
                  {t("settingsPage.workspace.people.columns.role")}
                </th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((member) => {
                const isSelf = user?.id === member.user_id;
                return (
                  <tr key={member.user_id} className={cn("h-14", ROW_DIVIDER)}>
                    {/* max-w-0 lets the cell's text truncate inside an auto-layout table. */}
                    <td className={cn("ps-4 pe-3 max-w-0", showTeams ? "w-[60%]" : "w-full")}>
                      <div className="flex items-center gap-3 min-w-0">
                        <MemberAvatar
                          name={member.name}
                          email={member.email}
                          image={member.image}
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <p dir="auto" className="text-xs font-medium text-foreground truncate">
                              {member.name || member.email}
                            </p>
                            {isSelf && (
                              <span className="shrink-0 rounded px-1.5 py-px text-[10px] font-medium bg-foreground/5 text-muted-foreground dark:bg-white/8">
                                {t("settingsPage.workspace.people.you")}
                              </span>
                            )}
                          </div>
                          {member.name && (
                            <p className="text-xs text-muted-foreground truncate">
                              <bdi dir="ltr">{member.email}</bdi>
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    {showTeams && <TeamCell teams={member.teams} />}
                    <td className="ps-3 pe-4 w-px whitespace-nowrap text-end">
                      <MemberRoleMenu
                        member={member}
                        isSelf={isSelf}
                        canManage={canManage}
                        canTransfer={canTransferOwnership}
                        pending={pendingRoleIds.has(member.user_id)}
                        onRoleChange={(role) => void handleRoleChange(member, role)}
                        onTransfer={() =>
                          dispatchTransfer({ type: "open", candidateId: member.user_id })
                        }
                        onRemove={() => dispatchRemove({ type: "open", subject: member })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <TransferOwnershipDialog
        workspace={workspace}
        state={transferState}
        dispatch={dispatchTransfer}
        // People is already showing, and the dialog toasts the outcome itself.
        onTransferred={() => {}}
      />

      <RemoveMemberDialog
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        state={removeState}
        dispatch={dispatchRemove}
      />
    </div>
  );
}

function TeamCell({ teams }: { teams: WorkspaceMember["teams"] }): React.ReactElement {
  const { t } = useTranslation();
  const { shown, more } = teamSummary(teams);
  const allNames = (teams ?? []).map((team) => team.name).join(" · ");

  return (
    <td className="px-3 w-[40%] max-w-0" title={allNames || undefined}>
      {shown.length === 0 ? (
        <span className="text-xs text-muted-foreground/70">
          {t("settingsPage.workspace.people.teamsNone")}
        </span>
      ) : (
        <p className="text-xs text-foreground truncate">
          <span dir="auto">{shown.join(" · ")}</span>
          {more > 0 && (
            <span className="text-muted-foreground">
              {" "}
              {t("settingsPage.workspace.people.teamsMore", { count: more })}
            </span>
          )}
        </p>
      )}
    </td>
  );
}
