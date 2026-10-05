import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Loader2 } from "../icons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { useToast } from "../ui/useToast";
import CreateWorkspaceDialog from "../CreateWorkspaceDialog";
import MemberPickList from "../MemberPickList";
import { createSpace } from "../../services/spaceActions";
import { TeamsService } from "../../services/TeamsService";
import { useWorkspace } from "../../hooks/useWorkspace";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useAuth } from "../../hooks/useAuth";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import SpaceNameField from "./SpaceNameField";
import { canManageWorkspace } from "../../lib/spacePermissions";
import {
  manageableWorkspaces as findManageableWorkspaces,
  selectWorkspaceForSpaceCreation,
} from "../../lib/workspaceSelection";
import { revealContainer, setActiveContext } from "../../stores/noteStore";
import { cn } from "../lib/utils";
import type { Team, WorkspaceMember } from "../../types/electron";

interface CreateSpaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Workspace preselected by the opener (e.g. a sidebar workspace row's + button). */
  initialWorkspaceId?: string | null;
}

export default function CreateSpaceDialog({
  open,
  onOpenChange,
  initialWorkspaceId = null,
}: CreateSpaceDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { workspaces, active, loaded, refresh } = useWorkspace();
  const {
    error: workspacesError,
    loading: workspacesLoading,
    members: roster,
    refreshMembers,
  } = useWorkspaceStore(
    useShallow((s) => ({
      error: s.error,
      loading: s.loading,
      members: s.members,
      refreshMembers: s.refreshMembers,
    }))
  );
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [membersError, setMembersError] = useState(false);
  const [rosterWorkspaceId, setRosterWorkspaceId] = useState<string | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamsError, setTeamsError] = useState(false);
  const [teamsWorkspaceId, setTeamsWorkspaceId] = useState<string | null>(null);
  const [selectedTeamIds, setSelectedTeamIds] = useState<Set<string>>(new Set());
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const showSpinner = useDelayedFlag(isCreating);

  const manageableWorkspaces = useMemo(() => findManageableWorkspaces(workspaces), [workspaces]);
  const defaultWorkspace = selectWorkspaceForSpaceCreation(manageableWorkspaces, active, null);
  const workspace = selectWorkspaceForSpaceCreation(
    manageableWorkspaces,
    active,
    selectedWorkspaceId
  );
  // A failed workspace fetch gets a retry state, never the create funnel.
  const needsWorkspace = open && loaded && !workspace && !workspacesError;
  const workspacesFailed = loaded && !workspace && workspacesError;

  const loadMembers = useCallback(
    async (workspaceId: string) => {
      setMembersError(false);
      setRosterWorkspaceId(null);
      try {
        await refreshMembers(workspaceId);
        setRosterWorkspaceId(workspaceId);
      } catch {
        setMembersError(true);
      }
    },
    [refreshMembers]
  );

  const loadTeams = useCallback(async (workspaceId: string) => {
    setTeamsError(false);
    setTeamsWorkspaceId(null);
    try {
      setTeams(await TeamsService.list(workspaceId));
      setTeamsWorkspaceId(workspaceId);
    } catch {
      setTeamsError(true);
    }
  }, []);

  useEffect(() => {
    if (open && workspace) {
      void loadMembers(workspace.id);
      void loadTeams(workspace.id);
    }
  }, [open, workspace, loadMembers, loadTeams]);

  useEffect(() => {
    if (!open) return;
    setSelectedWorkspaceId((current) => {
      if (current && manageableWorkspaces.some((w) => w.id === current)) return current;
      if (initialWorkspaceId && manageableWorkspaces.some((w) => w.id === initialWorkspaceId)) {
        return initialWorkspaceId;
      }
      return defaultWorkspace?.id ?? null;
    });
  }, [open, manageableWorkspaces, defaultWorkspace?.id, initialWorkspaceId]);

  // The creator becomes the space's admin on the server, so they are not a
  // pick-list candidate.
  const candidates = useMemo(
    () =>
      rosterWorkspaceId === workspace?.id
        ? roster.filter((member) => member.user_id !== user?.id)
        : [],
    [roster, rosterWorkspaceId, user?.id, workspace?.id]
  );
  const workspaceTeams = teamsWorkspaceId === workspace?.id ? teams : [];
  // Hold the section's place while the roster loads so the footer doesn't jump.
  const peopleLoading = workspace != null && rosterWorkspaceId !== workspace.id && !membersError;
  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setName("");
      setEmoji(null);
      setMemberSearch("");
      setSelectedIds(new Set());
      setRosterWorkspaceId(null);
      setTeams([]);
      setTeamsWorkspaceId(null);
      setSelectedTeamIds(new Set());
      setGroupsOpen(false);
      setSelectedWorkspaceId(null);
    }
  };

  // Chained CreateWorkspaceDialog: closing after a successful create keeps the
  // flow alive (the space dialog renders once the store has the workspace);
  // cancelling closes everything.
  const handleWorkspaceDialogChange = (nextOpen: boolean) => {
    if (nextOpen) return;
    const created = useWorkspaceStore.getState().workspaces.some((w) => canManageWorkspace(w.role));
    if (!created) onOpenChange(false);
  };

  const toggleMember = (member: WorkspaceMember) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(member.user_id)) next.add(member.user_id);
      return next;
    });
  };

  const toggleTeam = (teamId: string) => {
    setSelectedTeamIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(teamId)) next.add(teamId);
      return next;
    });
  };

  const handleWorkspaceChange = (workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId);
    setSelectedIds(new Set());
    setMemberSearch("");
    setMembersError(false);
    setSelectedTeamIds(new Set());
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || isCreating || !workspace) return;
    setIsCreating(true);
    try {
      const space = await createSpace(
        workspace.id,
        { name: trimmed, emoji },
        { memberIds: [...selectedIds], teamIds: [...selectedTeamIds] }
      );
      if (space) {
        revealContainer(space.id, null);
        setActiveContext(space.id, null);
        toast({ title: t("notes.spaces.created", { space: trimmed }) });
      }
      handleOpenChange(false);
    } catch (err) {
      toast({
        title: t("notes.spaces.couldNotCreate"),
        description: err instanceof Error ? err.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <>
      <CreateWorkspaceDialog open={needsWorkspace} onOpenChange={handleWorkspaceDialogChange} />

      <Dialog open={open && !needsWorkspace} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-95 p-6 gap-5">
          <DialogHeader>
            <DialogTitle>{t("notes.spaces.createTitle")}</DialogTitle>
            <DialogDescription>{t("notes.spaces.createDescription")}</DialogDescription>
          </DialogHeader>

          {workspacesFailed ? (
            <div className="rounded-lg border border-border/70 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 px-4 py-6 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">
                  {t("settingsPage.workspace.loadError.title")}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t("settingsPage.workspace.loadError.description")}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refresh()}
                disabled={workspacesLoading}
                className="shrink-0"
              >
                {workspacesLoading && <Loader2 className="me-1.5 h-3 w-3 animate-spin" />}
                {t("settingsPage.workspace.loadError.retry")}
              </Button>
            </div>
          ) : (
            <>
              {/* Anyone in several workspaces sees the target workspace, even
                  when only one of them is manageable (no picker to infer from).
                  Opening from a workspace row's + already chose the target, so
                  it renders as fixed context rather than a picker. */}
              {workspaces.length > 1 && workspace && (
                <div className="space-y-1.5">
                  {manageableWorkspaces.length > 1 && !initialWorkspaceId ? (
                    <>
                      <label
                        htmlFor="create-space-workspace"
                        className="text-xs font-medium text-foreground/50"
                      >
                        {t("settingsPage.workspace.title")}
                      </label>
                      <Select value={workspace.id} onValueChange={handleWorkspaceChange}>
                        <SelectTrigger id="create-space-workspace">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {manageableWorkspaces.map((item) => (
                            <SelectItem key={item.id} value={item.id}>
                              <span dir="auto">{item.name}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </>
                  ) : (
                    <>
                      <p className="text-xs font-medium text-foreground/50">
                        {t("settingsPage.workspace.title")}
                      </p>
                      <p dir="auto" className="text-sm text-foreground truncate">
                        {workspace.name}
                      </p>
                    </>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <label
                  htmlFor="create-space-name"
                  className="text-xs font-medium text-foreground/50"
                >
                  {t("notes.spaces.nameAndIconLabel")}
                </label>
                <SpaceNameField
                  id="create-space-name"
                  name={name}
                  emoji={emoji}
                  autoFocus
                  onNameChange={setName}
                  onEmojiChange={setEmoji}
                  onEnter={() => handleCreate()}
                />
              </div>

              {/* A workspace of one has nobody to add; the section only
                  appears once the roster shows other people (or failed). */}
              {(peopleLoading || membersError || candidates.length > 0) && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-foreground/50">
                    {t("notes.spaces.members.addPeople")}
                  </p>
                  {peopleLoading ? (
                    <div className="h-24 rounded-lg bg-foreground/5 dark:bg-white/5 animate-pulse" />
                  ) : membersError ? (
                    <div className="rounded border border-border/70 dark:border-border-subtle/60 px-3 py-2.5 flex items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">
                        {t("settingsPage.workspace.members.loadError")}
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          if (workspace) void loadMembers(workspace.id);
                        }}
                        className="h-6 px-2 text-xs shrink-0"
                      >
                        {t("settingsPage.workspace.loadError.retry")}
                      </Button>
                    </div>
                  ) : (
                    <MemberPickList
                      members={candidates}
                      search={memberSearch}
                      onSearchChange={setMemberSearch}
                      onSelect={toggleMember}
                      selectedIds={selectedIds}
                      currentUserId={user?.id}
                    />
                  )}
                </div>
              )}

              {(teamsError || workspaceTeams.length > 0) && (
                <div className="space-y-1.5">
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
                      <span className="text-xs font-medium text-foreground/50 truncate">
                        {t("notes.spaces.groups.optional")}
                      </span>
                      {selectedTeamIds.size > 0 && (
                        <span className="ms-auto text-[10px] text-foreground/45 shrink-0">
                          {selectedTeamIds.size}
                        </span>
                      )}
                    </button>
                  </div>
                  {groupsOpen &&
                    (teamsError ? (
                      <div className="rounded border border-border/70 dark:border-border-subtle/60 px-3 py-2.5 flex items-center justify-between gap-2">
                        <p className="text-xs text-muted-foreground">
                          {t("notes.spaces.teams.loadError")}
                        </p>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (workspace) void loadTeams(workspace.id);
                          }}
                          className="h-6 px-2 text-xs shrink-0"
                        >
                          {t("settingsPage.workspace.loadError.retry")}
                        </Button>
                      </div>
                    ) : (
                      <div className="rounded border border-border/70 dark:border-border-subtle/60 overflow-y-auto max-h-36 p-1">
                        {workspaceTeams.map((team) => {
                          const isSelected = selectedTeamIds.has(team.id);
                          return (
                            <button
                              key={team.id}
                              type="button"
                              aria-pressed={isSelected}
                              onClick={() => toggleTeam(team.id)}
                              className={cn(
                                "flex items-center gap-2 w-full px-2 h-8 rounded-md text-start",
                                "transition-colors duration-150 outline-none",
                                "hover:bg-foreground/4 dark:hover:bg-white/4",
                                "focus-visible:ring-1 focus-visible:ring-ring/30"
                              )}
                            >
                              <span dir="auto" className="text-xs text-foreground truncate flex-1">
                                {team.name}
                              </span>
                              <span className="text-[10px] text-foreground/45 shrink-0">
                                {t("settingsPage.workspace.teams.memberCount", {
                                  count: team.member_count ?? 0,
                                })}
                              </span>
                              {isSelected && <Check size={11} className="text-primary shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                </div>
              )}

              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => handleOpenChange(false)}
                  disabled={isCreating}
                >
                  {t("common.cancel")}
                </Button>
                <Button onClick={handleCreate} disabled={!name.trim() || isCreating || !workspace}>
                  {showSpinner && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
                  {t("notes.spaces.create")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
