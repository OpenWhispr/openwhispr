import React, { useEffect, useReducer, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { ChevronDown, Loader2, Search, Users, X } from "../icons";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { WorkspacesService } from "../../services/WorkspacesService";
import { useAuth } from "../../hooks/useAuth";
import { useHeldTeamIds } from "../../hooks/useHeldTeamIds";
import { Button } from "../ui/button";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "../ui/BidiInterpolatedText";
import { ESCAPE_CLEARS_ATTRIBUTE } from "../ui/escapeClears";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useToast } from "../ui/useToast";
import type { Workspace, WorkspaceJoinRequest, WorkspaceMember } from "../../types/electron";
import MemberAvatar from "../MemberAvatar";
import { cn } from "../lib/utils";
import { isolate } from "../../utils/bidiIsolate";
import { teamCreationFor, workspaceCan } from "../../lib/capabilities";
import { withoutHeldTeams } from "../../lib/heldTeamDeletes";
import { memberRemovalReducer } from "../../lib/memberRemovalFlow";
import {
  headerCheckState,
  keepRows,
  setRows,
  toggleRow,
  type RowSelection,
} from "../../lib/rowSelection";
import { membersView, rosterFor, rosterHasTeams } from "../../lib/peopleRoster";
import { classifyRowActionError, type RowActionError } from "../../lib/workspaceErrors";
import { transferReducer } from "../../lib/workspaceTransferFlow";
import CreateTeamDialog from "../CreateTeamDialog";
import TeamPaywallDialog from "../workspace/TeamPaywallDialog";
import { RemoveMembersDialog } from "../workspace/RemoveMembersDialog";
import { RowCheckbox } from "../dictionary/RowCheckbox";
import { useAddToTeamspace } from "../workspace/AddToTeamspaceMenu";
import { PeopleAddMenu, useAddPeopleToTeam } from "../workspace/PeopleAddMenu";
import { SelectionBar } from "../workspace/SelectionBar";
import { TransferOwnershipDialog } from "../workspace/TransferOwnershipDialog";
import { MemberRoleMenu } from "./MemberRoleMenu";
import { CONTACTS_TRIGGER, HEADER_CELL, ROW_DIVIDER, TABLE_FRAME } from "./tableTokens";

interface WorkspaceMembersTabProps {
  workspace: Workspace;
  /** Filters the table by name or email. */
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  /** Where "Open teamspace" in the toast after an add goes; omitted, the toast has no such action. */
  onOpenTeamspace?: (localSpaceId: number) => void;
}

const SKELETON_ROWS = 3;
const HEADER_CHECKED = { none: false, some: "mixed", all: true } as const;
// A bigger target than the box, without moving it.
const ROW_CHECKBOX = "-m-1 p-1 focus-visible:ring-primary/50";

export default function WorkspaceMembersTab({
  workspace,
  searchQuery,
  onSearchQueryChange,
  onOpenTeamspace,
}: WorkspaceMembersTabProps): React.ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { members, rosterIsOurs, refreshMembers } = useWorkspaceStore(
    useShallow((s) => ({
      members: rosterFor(s, workspace.id),
      rosterIsOurs: s.membersWorkspaceId === workspace.id,
      refreshMembers: s.refreshMembers,
    }))
  );
  const [transferState, dispatchTransfer] = useReducer(transferReducer, { kind: "closed" });
  const [removeState, dispatchRemove] = useReducer(memberRemovalReducer, { kind: "closed" });
  const [selection, setSelection] = useState<RowSelection>(() => new Set());
  const [joinRequests, setJoinRequests] = useState<WorkspaceJoinRequest[]>([]);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  // The roster loads on mount, so an empty one starts out loading rather than as a table with no rows.
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState(false);
  const [pendingRoleIds, setPendingRoleIds] = useState<ReadonlySet<string>>(() => new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rereadRef = useRef(false);
  const canManage = workspaceCan(workspace, "manage_members");
  // One controller for Add to team (the bar's and every row's), and one for Add to teamspace, each
  // with its dialog beside the table: the bar goes away when a roster refresh empties the
  // selection, and a dialog inside it would go with it.
  const teamAdd = useAddPeopleToTeam(workspace);
  const barOpenerRef = useRef<HTMLElement | null>(null);
  // Create team lives here for the same reason. The form keeps the people it opened with, since
  // the selection clears the moment a team is created while the dialog finishes closing.
  const [createOpen, setCreateOpen] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [createPeople, setCreatePeople] = useState<WorkspaceMember[]>([]);
  // A dialog and a selection belong to the workspace they were made in: the page can re-point at
  // another one under them, and Create would then send the old people to the new workspace's teams.
  const [dialogWorkspaceId, setDialogWorkspaceId] = useState(workspace.id);
  if (workspace.id !== dialogWorkspaceId) {
    setDialogWorkspaceId(workspace.id);
    setCreateOpen(false);
    setPaywallOpen(false);
    setCreatePeople([]);
    setSelection(new Set());
  }
  const teamCreation = teamCreationFor(workspace);
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

  // A re-read for another workspace (a role change that finished after a switch) can take the
  // store's one roster slot. Read this workspace's again, once, rather than show nobody. If that
  // read is overtaken by another workspace's too, the failed view offers Try again instead of
  // retrying here, where two views of different workspaces would take turns forever.
  useEffect(() => {
    if (membersLoading || membersError) return;
    if (rosterIsOurs) {
      rereadRef.current = false;
      return;
    }
    if (rereadRef.current) {
      setMembersError(true);
      return;
    }
    rereadRef.current = true;
    void loadMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membersLoading, membersError, rosterIsOurs]);

  function setRolePending(userId: string, pending: boolean): void {
    setPendingRoleIds((current) => {
      const next = new Set(current);
      if (pending) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }

  function roleChangeError(failure: RowActionError, name: string): string {
    switch (failure.kind) {
      case "refused":
        return failure.message;
      case "gone":
        return t("workspaces.removeMember.alreadyRemoved", { name: isolate(name) });
      case "notAllowed":
        return t("settingsPage.workspace.people.roleNotAllowed", {
          workspace: isolate(workspace.name),
        });
      case "ssoRequired":
        return t("workspaces.ssoRequired", { workspace: isolate(workspace.name) });
      case "rateLimited":
      case "failed":
        return t("settingsPage.workspace.people.roleFailed", { name: isolate(name) });
    }
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
        description: roleChangeError(failure, name),
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

  function clearSearch(): void {
    onSearchQueryChange("");
    searchInputRef.current?.focus();
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    // An empty field leaves Escape alone so it can still close the Settings dialog.
    if (event.key !== "Escape" || !searchQuery) return;
    event.preventDefault();
    event.stopPropagation();
    clearSearch();
  }

  const view = membersView({
    loading: membersLoading,
    error: membersError,
    members,
    query: searchQuery,
  });
  const showTeams = rosterHasTeams(members);

  // Your own row has no checkbox. The owner's has one, for adding them to teams and teamspaces;
  // Remove leaves them out, since the owner can't be removed.
  const isSelectable = (member: WorkspaceMember): boolean =>
    canManage && member.user_id !== user?.id;
  const selectableMembers = view.kind === "rows" ? view.rows.filter(isSelectable) : [];
  const selectableIds = selectableMembers.map((member) => member.user_id);
  const headerChecked = HEADER_CHECKED[headerCheckState(selectableIds, selection)];
  const selectedMembers = selectableMembers.filter((member) => selection.has(member.user_id));
  const removableMembers = selectedMembers.filter((member) => member.role !== "owner");
  const ownerSelected = removableMembers.length < selectedMembers.length;
  const selectableKey = selectableIds.join(",");
  // Adding clears the selection, and the bar goes with it, taking the button that opened the menu
  // or dialog. Focus moves to the search field rather than dropping to the page.
  const clearSelectionAfterAdding = (): void => {
    setSelection(new Set());
    requestAnimationFrame(() => searchInputRef.current?.focus());
  };
  const teamspace = useAddToTeamspace({
    workspace,
    people: selectedMembers,
    onAdded: clearSelectionAfterAdding,
    onOpenTeamspace,
    returnFocusRef: barOpenerRef,
  });

  // Remove acts on what is on screen, so a search or a roster change drops the rows it hides.
  useEffect(() => {
    setSelection((current) => keepRows(current, selectableIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectableKey]);

  function startCreateTeam(): void {
    if (teamCreation === "allowed") {
      setCreatePeople(selectedMembers);
      setCreateOpen(true);
    } else if (teamCreation === "paywall") {
      setPaywallOpen(true);
    }
  }

  function openRemoval(subjects: WorkspaceMember[]): void {
    dispatchRemove({ type: "open", subjects, defaultOwnerId: user?.id ?? "" });
  }

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

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:w-[280px]">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70"
          />
          <Input
            ref={searchInputRef}
            type="search"
            dir="auto"
            autoComplete="off"
            spellCheck={false}
            value={searchQuery}
            placeholder={t("settingsPage.workspace.people.search.placeholder")}
            aria-label={t("settingsPage.workspace.people.search.placeholder")}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            // Lets the Settings dialog hold its own Escape while there is a query to clear.
            {...{ [ESCAPE_CLEARS_ATTRIBUTE]: searchQuery ? "" : undefined }}
            className="h-[38px] rounded-xl ps-9 pe-9 text-xs [&::-webkit-search-cancel-button]:appearance-none"
          />
          {searchQuery && (
            <button
              type="button"
              aria-label={t("settingsPage.workspace.people.search.clear")}
              onClick={clearSearch}
              className="absolute end-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          )}
        </div>
        {/* The seat count is the workspace's, so a search that matches nobody keeps it. */}
        {canManage && (view.kind === "rows" || view.kind === "noResults") && (
          <p className="ms-auto text-xs text-muted-foreground/80">
            {t("settingsPage.workspace.members.description", {
              // Pending invitations hold seats too, as the invite dialog counts them.
              count: workspace.seats_used ?? members.length,
              seats: workspace.seats,
            })}
          </p>
        )}
      </div>

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

      {view.kind === "noResults" && (
        <div className={cn(TABLE_FRAME, "px-4 py-8 text-center")}>
          <p className="text-xs font-medium text-foreground">
            <BidiInterpolatedText
              text={t("settingsPage.workspace.people.search.noResultsTitle", {
                query: BIDI_VALUE_TOKEN,
              })}
              value={view.query}
              dir="auto"
            />
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("settingsPage.workspace.people.search.noResultsBody")}
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={clearSearch}>
            {t("settingsPage.workspace.people.search.clear")}
          </Button>
        </div>
      )}

      {view.kind === "rows" && (
        <div className={TABLE_FRAME}>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {canManage && (
                  <th scope="col" className={cn(HEADER_CELL, "w-10 ps-4 pe-0 text-start")}>
                    {selectableIds.length > 0 && (
                      <RowCheckbox
                        label={t("settingsPage.workspace.people.selection.selectAllMembers")}
                        checked={headerChecked}
                        className={ROW_CHECKBOX}
                        onToggle={() =>
                          setSelection((current) =>
                            setRows(current, selectableIds, headerChecked !== true)
                          )
                        }
                      />
                    )}
                  </th>
                )}
                <th
                  scope="col"
                  className={cn(HEADER_CELL, "pe-3 text-start", canManage ? "ps-3" : "ps-4")}
                >
                  {t("settingsPage.workspace.people.columns.name")}
                </th>
                {showTeams && (
                  <th scope="col" className={cn(HEADER_CELL, "px-3 text-start")}>
                    {t("settingsPage.workspace.people.columns.team")}
                  </th>
                )}
                <th scope="col" className={cn(HEADER_CELL, "ps-3 pe-4 text-end whitespace-nowrap")}>
                  {t("settingsPage.workspace.people.columns.role")}
                </th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((member) => {
                const isSelf = user?.id === member.user_id;
                return (
                  <tr key={member.user_id} className={cn("h-14", ROW_DIVIDER)}>
                    {canManage && (
                      <td className="w-10 ps-4 pe-0">
                        {isSelectable(member) && (
                          <RowCheckbox
                            label={t("settingsPage.workspace.people.selection.selectRow", {
                              name: isolate(member.name || member.email),
                            })}
                            checked={selection.has(member.user_id)}
                            className={ROW_CHECKBOX}
                            onToggle={() =>
                              setSelection((current) => toggleRow(current, member.user_id))
                            }
                          />
                        )}
                      </td>
                    )}
                    {/* max-w-0 lets the cell's text truncate inside an auto-layout table. */}
                    <td
                      className={cn(
                        "pe-3 max-w-0",
                        canManage ? "ps-3" : "ps-4",
                        showTeams ? "w-[60%]" : "w-full"
                      )}
                    >
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
                        onRemove={() => openRemoval([member])}
                        workspace={canManage ? workspace : undefined}
                        teamAdd={canManage ? teamAdd : undefined}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <SelectionBar
        count={selectedMembers.length}
        onClear={() => setSelection(new Set())}
        actions={
          removableMembers.length > 0
            ? [
                {
                  id: "remove",
                  label: t("settingsPage.workspace.people.selection.remove"),
                  tone: "destructive",
                  onClick: () => openRemoval(removableMembers),
                },
              ]
            : []
        }
        // Only whoever manages members can select anyone, so the bar and this menu share that check.
        trailing={
          <PeopleAddMenu
            workspace={workspace}
            people={selectedMembers}
            onAdded={clearSelectionAfterAdding}
            teamAdd={teamAdd}
            teamspace={teamspace}
            openerRef={barOpenerRef}
            onCreateTeam={startCreateTeam}
          />
        }
      />

      {teamAdd.dialog}
      {teamspace.dialog}

      {teamCreation !== "unavailable" && (
        <>
          <CreateTeamDialog
            workspace={workspace}
            open={createOpen}
            onOpenChange={setCreateOpen}
            initialPeople={createPeople}
            onCreated={async () => {
              // The dialog has toasted; the Team column reads the roster.
              clearSelectionAfterAdding();
              await refreshMembers(workspace.id).catch(() => undefined);
            }}
            onPlanRequired={() => {
              setCreateOpen(false);
              setPaywallOpen(true);
            }}
          />
          <TeamPaywallDialog
            workspace={workspace}
            open={paywallOpen}
            onOpenChange={setPaywallOpen}
          />
        </>
      )}

      <TransferOwnershipDialog
        workspace={workspace}
        state={transferState}
        dispatch={dispatchTransfer}
        // People is already showing, and the dialog toasts the outcome itself.
        onTransferred={() => {}}
      />

      <RemoveMembersDialog
        workspace={workspace}
        roster={members}
        state={removeState}
        dispatch={dispatchRemove}
        ownerKept={ownerSelected}
        onRemoved={(removedIds) => setSelection((current) => setRows(current, removedIds, false))}
      />
    </div>
  );
}

function TeamCell({ teams }: { teams: WorkspaceMember["teams"] }): React.ReactElement {
  const { t } = useTranslation();
  const heldTeams = useHeldTeamIds();
  const list = withoutHeldTeams(teams ?? [], heldTeams);

  return (
    <td className="px-3 w-[40%] max-w-0">
      {list.length === 0 ? (
        <span className="text-xs text-muted-foreground/70">
          {t("settingsPage.workspace.people.teamsNone")}
        </span>
      ) : list.length === 1 ? (
        <div className="flex min-w-0 items-center gap-2 text-xs text-foreground">
          <Users className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span dir="auto" className="min-w-0 truncate">
            {list[0].name}
          </span>
        </div>
      ) : (
        <Popover>
          <PopoverTrigger className={CONTACTS_TRIGGER}>
            <span className="truncate">
              {t("settingsPage.workspace.people.teamsCount", { count: list.length })}
            </span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56 p-1.5">
            <ul className="flex flex-col">
              {list.map((team) => (
                <li key={team.id} className="flex items-center gap-2 px-2 py-1.5">
                  <Users className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span dir="auto" className="min-w-0 truncate text-xs text-foreground">
                    {team.name}
                  </span>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
    </td>
  );
}
