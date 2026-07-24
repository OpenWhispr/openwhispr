import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { useToast } from "../ui/useToast";
import CreateWorkspaceDialog from "../CreateWorkspaceDialog";
import MemberPickList from "../MemberPickList";
import { createSpace } from "../../services/spaceActions";
import { TeamsService } from "../../services/TeamsService";
import { CloudApiError } from "../../services/cloudApi";
import { useWorkspace } from "../../hooks/useWorkspace";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useAuth } from "../../hooks/useAuth";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { clampEmojiInput } from "../../lib/emojiInput";
import { orderMemberCandidates } from "../../lib/memberCandidates";
import {
  manageableWorkspaces as findManageableWorkspaces,
  selectWorkspaceForSpaceCreation,
} from "../../lib/workspaceSelection";
import { revealContainer, setActiveContext } from "../../stores/noteStore";
import { cn } from "../lib/utils";
import type { Team, WorkspaceMember } from "../../types/electron";

const EMOJI_CHOICES = [
  "📝",
  "📋",
  "💡",
  "🚀",
  "🎯",
  "📣",
  "🛠️",
  "🎨",
  "📊",
  "💼",
  "🤝",
  "🌱",
  "🔬",
  "🧪",
  "📚",
  "✨",
  "🔥",
  "⭐",
  "💬",
  "🗂️",
  "🧭",
  "🌍",
  "🔒",
  "🏆",
];

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
  const [emoji, setEmoji] = useState("");
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const emojiInputRef = useRef<HTMLInputElement>(null);
  const [memberSearch, setMemberSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [membersError, setMembersError] = useState(false);
  const [rosterWorkspaceId, setRosterWorkspaceId] = useState<string | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamsError, setTeamsError] = useState(false);
  const [teamsWorkspaceId, setTeamsWorkspaceId] = useState<string | null>(null);
  const [selectedTeamIds, setSelectedTeamIds] = useState<Set<string>>(new Set());
  const [newTeamOpen, setNewTeamOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
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
      const list = await TeamsService.list(workspaceId);
      setTeams(list);
      setTeamsWorkspaceId(workspaceId);
      // A workspace with no teams yet keeps the one-shot flow: the new-team
      // section opens straight away, prefilled from the space name at submit.
      if (list.length === 0) setNewTeamOpen(true);
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

  const candidates = useMemo(
    () => (rosterWorkspaceId === workspace?.id ? orderMemberCandidates(roster, user?.id) : []),
    [roster, rosterWorkspaceId, user?.id, workspace?.id]
  );
  const filteredCandidates = useMemo(() => {
    const query = memberSearch.trim().toLowerCase();
    if (!query) return candidates;
    return candidates.filter(
      (m) => (m.name ?? "").toLowerCase().includes(query) || m.email.toLowerCase().includes(query)
    );
  }, [candidates, memberSearch]);

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setName("");
      setEmoji("");
      setEmojiPickerOpen(false);
      setMemberSearch("");
      setSelectedIds(new Set());
      setRosterWorkspaceId(null);
      setTeams([]);
      setTeamsWorkspaceId(null);
      setSelectedTeamIds(new Set());
      setNewTeamOpen(false);
      setNewTeamName("");
      setSelectedWorkspaceId(null);
    }
  };

  // Chained CreateWorkspaceDialog: closing after a successful create keeps the
  // flow alive (the space dialog renders once the store has the workspace);
  // cancelling closes everything.
  const handleWorkspaceDialogChange = (nextOpen: boolean) => {
    if (nextOpen) return;
    const created = useWorkspaceStore
      .getState()
      .workspaces.some((w) => w.role === "owner" || w.role === "admin");
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

  // Linux has no OS emoji panel; the in-app grid is the fallback.
  const openEmojiPicker = async (): Promise<void> => {
    const nativeShown = await window.electronAPI?.showEmojiPanel?.().catch(() => false);
    if (!nativeShown) setEmojiPickerOpen(true);
  };

  const handleWorkspaceChange = (workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId);
    setSelectedIds(new Set());
    setMemberSearch("");
    setMembersError(false);
    setSelectedTeamIds(new Set());
    setNewTeamOpen(false);
    setNewTeamName("");
  };

  // A space needs at least one team (existing or new) unless team loading
  // failed — then the server-side zero-team create still lets admins proceed.
  const hasTeamSelection = selectedTeamIds.size > 0 || newTeamOpen || teamsError;

  // Teams for the target workspace haven't arrived yet: skeleton the section
  // (a bare "New team" button next to the label reads as misplaced UI).
  const teamsLoading = !teamsError && teamsWorkspaceId !== workspace?.id;

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || isCreating || !workspace || !hasTeamSelection) return;
    setIsCreating(true);
    try {
      // The server adds the creator to a new team as admin; re-adding them
      // here would upsert that role back down to member.
      const memberIds = [...selectedIds].filter((id) => id !== user?.id);
      const { space, failedMembers } = await createSpace(
        workspace.id,
        { name: trimmed, emoji: emoji.trim() || null },
        {
          existingTeamIds: [...selectedTeamIds],
          newTeam: newTeamOpen ? { name: newTeamName.trim() || trimmed, memberIds } : undefined,
        }
      );
      if (failedMembers > 0) {
        toast({
          title: t("notes.spaces.members.addFailed", {
            failed: failedMembers,
            total: memberIds.length,
          }),
          variant: "destructive",
        });
      }
      if (space) {
        revealContainer(space.id, null);
        setActiveContext(space.id, null);
      }
      handleOpenChange(false);
    } catch (err) {
      toast({
        title: t("notes.spaces.couldNotCreate"),
        description:
          err instanceof CloudApiError && err.code === "upgrade_required"
            ? t("notes.spaces.upgradeRequired")
            : err instanceof Error
              ? err.message
              : t("common.unknownError"),
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
            <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 px-4 py-6 flex items-center justify-between gap-3">
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
                {workspacesLoading && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
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
                  <label className="text-xs font-medium text-foreground/50">
                    {t("settingsPage.workspace.title")}
                  </label>
                  {manageableWorkspaces.length > 1 && !initialWorkspaceId ? (
                    <Select value={workspace.id} onValueChange={handleWorkspaceChange}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {manageableWorkspaces.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-sm text-foreground truncate">{workspace.name}</p>
                  )}
                </div>
              )}

              <div className="flex gap-3">
                <div className="space-y-1.5 w-14 shrink-0">
                  <label className="text-xs font-medium text-foreground/50">
                    {t("notes.spaces.emojiLabel")}
                  </label>
                  <Popover open={emojiPickerOpen} onOpenChange={setEmojiPickerOpen}>
                    <PopoverAnchor asChild>
                      <Input
                        ref={emojiInputRef}
                        value={emoji}
                        onChange={(e) => setEmoji(clampEmojiInput(e.target.value))}
                        onClick={() => void openEmojiPicker()}
                        aria-label={t("notes.spaces.changeEmoji")}
                        className="text-center"
                      />
                    </PopoverAnchor>
                    <PopoverContent
                      className="w-auto min-w-0 p-1.5"
                      onOpenAutoFocus={(e) => e.preventDefault()}
                      onCloseAutoFocus={(e) => e.preventDefault()}
                      onInteractOutside={(e) => {
                        if (e.target === emojiInputRef.current) e.preventDefault();
                      }}
                    >
                      <div className="grid grid-cols-8 gap-0.5">
                        {EMOJI_CHOICES.map((choice) => (
                          <button
                            key={choice}
                            type="button"
                            onClick={() => {
                              setEmoji(choice === emoji ? "" : choice);
                              setEmojiPickerOpen(false);
                              emojiInputRef.current?.focus();
                            }}
                            className={cn(
                              "flex h-7 w-7 items-center justify-center rounded-md text-base outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
                              choice === emoji && "bg-accent"
                            )}
                          >
                            {choice}
                          </button>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
                <div className="space-y-1.5 flex-1">
                  <label className="text-xs font-medium text-foreground/50">
                    {t("notes.spaces.nameLabel")}
                  </label>
                  <Input
                    value={name}
                    autoFocus
                    maxLength={80}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreate();
                    }}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground/50">
                  {t("notes.spaces.teams.assignLabel")}
                </label>
                {teamsError && teams.length === 0 ? (
                  <div className="rounded border border-border/70 dark:border-border-subtle/50 px-3 py-2.5 flex items-center justify-between gap-2">
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
                ) : teamsLoading ? (
                  <div className="h-24 rounded bg-foreground/5 dark:bg-white/5 animate-pulse" />
                ) : (
                  <>
                    {teams.length > 0 && (
                      <div className="rounded border border-border/70 dark:border-border-subtle/50 overflow-y-auto max-h-36 p-1">
                        {teams.map((team) => {
                          const isSelected = selectedTeamIds.has(team.id);
                          return (
                            <button
                              key={team.id}
                              type="button"
                              aria-pressed={isSelected}
                              onClick={() => toggleTeam(team.id)}
                              className={cn(
                                "flex items-center gap-2 w-full px-2 h-8 rounded-md text-left",
                                "transition-colors duration-150 outline-none",
                                "hover:bg-foreground/4 dark:hover:bg-white/4",
                                "focus-visible:ring-1 focus-visible:ring-ring/30"
                              )}
                            >
                              <span className="text-xs text-foreground truncate flex-1">
                                {team.name}
                              </span>
                              <span className="text-[10px] text-foreground/40 shrink-0">
                                {t("settingsPage.workspace.teams.memberCount", {
                                  count: team.member_count ?? 0,
                                })}
                              </span>
                              {isSelected && <Check size={11} className="text-primary shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    )}
                    {newTeamOpen ? (
                      <div className="rounded border border-border/70 dark:border-border-subtle/50 p-2.5 space-y-2">
                        <div className="space-y-1.5">
                          <label className="text-xs font-medium text-foreground/50">
                            {t("notes.spaces.teams.newTeamNameLabel")}
                          </label>
                          <Input
                            value={newTeamName}
                            maxLength={80}
                            placeholder={name.trim() || undefined}
                            onChange={(e) => setNewTeamName(e.target.value)}
                          />
                        </div>
                        {membersError && candidates.length === 0 ? (
                          <div className="flex items-center justify-between gap-2">
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
                        ) : candidates.length > 0 ? (
                          <MemberPickList
                            members={filteredCandidates}
                            search={memberSearch}
                            onSearchChange={setMemberSearch}
                            onSelect={toggleMember}
                            selectedIds={selectedIds}
                            currentUserId={user?.id}
                          />
                        ) : null}
                        {teams.length > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setNewTeamOpen(false);
                              setNewTeamName("");
                              setSelectedIds(new Set());
                            }}
                            className="h-6 px-2 text-xs"
                          >
                            {t("notes.upload.cancel")}
                          </Button>
                        )}
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setNewTeamOpen(true)}
                        className="h-7 px-2 text-xs text-foreground/60"
                      >
                        <Plus size={12} className="mr-1" />
                        {t("notes.spaces.teams.newTeam")}
                      </Button>
                    )}
                  </>
                )}
              </div>

              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => handleOpenChange(false)}
                  disabled={isCreating}
                >
                  {t("notes.upload.cancel")}
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={!name.trim() || isCreating || !workspace || !hasTeamSelection}
                >
                  {showSpinner && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
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
