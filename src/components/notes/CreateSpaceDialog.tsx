import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useToast } from "../ui/useToast";
import CreateWorkspaceDialog from "../CreateWorkspaceDialog";
import MemberPickList from "../MemberPickList";
import { createTeamSpace } from "../../services/teamSpaceActions";
import { useWorkspace } from "../../hooks/useWorkspace";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useAuth } from "../../hooks/useAuth";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { revealContainer, setActiveContext } from "../../stores/noteStore";
import type { WorkspaceMember } from "../../types/electron";

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
  const [memberSearch, setMemberSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [membersError, setMembersError] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const showSpinner = useDelayedFlag(isCreating);

  // Multiple workspaces with none active: default to the first the user can
  // create spaces in (owner/admin) — kept deliberately simple for v1.
  const workspace =
    active ?? workspaces.find((w) => w.role === "owner" || w.role === "admin") ?? null;
  // A failed workspace fetch gets a retry state, never the create funnel.
  const needsWorkspace = open && loaded && !workspace && !workspacesError;
  const workspacesFailed = loaded && !workspace && workspacesError;

  const loadMembers = useCallback(
    async (workspaceId: string) => {
      setMembersError(false);
      try {
        await refreshMembers(workspaceId);
      } catch {
        setMembersError(true);
      }
    },
    [refreshMembers]
  );

  useEffect(() => {
    if (open && workspace) void loadMembers(workspace.id);
  }, [open, workspace, loadMembers]);

  const candidates = useMemo(
    () => roster.filter((m) => m.user_id !== user?.id),
    [roster, user?.id]
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
      setMemberSearch("");
      setSelectedIds(new Set());
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
              <div className="flex gap-3">
                <div className="space-y-1.5 w-14 shrink-0">
                  <label className="text-xs font-medium text-foreground/50">
                    {t("notes.spaces.emojiLabel")}
                  </label>
                  <Input
                    value={emoji}
                    onChange={(e) => setEmoji(e.target.value)}
                    maxLength={4}
                    className="text-center"
                  />
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
