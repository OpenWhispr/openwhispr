import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
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
import { createTeamSpace } from "../../services/teamSpaceActions";
import { CloudApiError } from "../../services/cloudApi";
import { useWorkspace } from "../../hooks/useWorkspace";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useAuth } from "../../hooks/useAuth";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { clampEmojiInput } from "../../lib/emojiInput";
import {
  manageableWorkspaces as findManageableWorkspaces,
  selectWorkspaceForSpaceCreation,
} from "../../lib/workspaceSelection";
import { revealContainer, setActiveContext } from "../../stores/noteStore";
import { cn } from "../lib/utils";
import type { WorkspaceMember } from "../../types/electron";

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
}

export default function CreateSpaceDialog({ open, onOpenChange }: CreateSpaceDialogProps) {
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

  useEffect(() => {
    if (open && workspace) void loadMembers(workspace.id);
  }, [open, workspace, loadMembers]);

  useEffect(() => {
    if (!open) return;
    setSelectedWorkspaceId((current) => {
      if (current && manageableWorkspaces.some((w) => w.id === current)) return current;
      return defaultWorkspace?.id ?? null;
    });
  }, [open, manageableWorkspaces, defaultWorkspace?.id]);

  const candidates = useMemo(
    () => (rosterWorkspaceId === workspace?.id ? roster.filter((m) => m.user_id !== user?.id) : []),
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
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || isCreating || !workspace) return;
    setIsCreating(true);
    try {
      const memberIds = [...selectedIds];
      const { space, failedMembers } = await createTeamSpace(
        workspace.id,
        { name: trimmed, emoji: emoji.trim() || null },
        memberIds
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
              {manageableWorkspaces.length > 1 && workspace && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground/50">
                    {t("settingsPage.workspace.title")}
                  </label>
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

              {membersError && candidates.length === 0 ? (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground/50">
                    {t("notes.spaces.members.addPeople")}
                  </label>
                  <div className="rounded border border-border/70 dark:border-border-subtle/50 px-3 py-2.5 flex items-center justify-between gap-2">
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
                </div>
              ) : candidates.length > 0 ? (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground/50">
                    {t("notes.spaces.members.addPeople")}
                  </label>
                  <MemberPickList
                    members={filteredCandidates}
                    search={memberSearch}
                    onSearchChange={setMemberSearch}
                    onSelect={toggleMember}
                    selectedIds={selectedIds}
                  />
                </div>
              ) : null}

              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => handleOpenChange(false)}
                  disabled={isCreating}
                >
                  {t("notes.upload.cancel")}
                </Button>
                <Button onClick={handleCreate} disabled={!name.trim() || isCreating || !workspace}>
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
