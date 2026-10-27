import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Loader2 } from "./icons";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { useToast } from "./ui/useToast";
import MemberPickList from "./MemberPickList";
import { TeamsService } from "../services/TeamsService";
import { addTeamMembers } from "../services/spaceActions";
import { orderMemberCandidates } from "../lib/memberCandidates";
import { useWorkspaceStore, EMPTY_WORKSPACE_MEMBERS } from "../stores/workspaceStore";
import { useAuth } from "../hooks/useAuth";
import { useDelayedFlag } from "../hooks/useDelayedFlag";
import { useDialogSession, type DialogCompletion } from "../hooks/useDialogSession";
import type { Team, WorkspaceMember } from "../types/electron";

interface CreateTeamDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current-session UI (e.g. success feedback). */
  onCreated?: (team: Team) => void | Promise<void>;
  /** Completed-action reconciliation, even after dismissal for the same account. */
  onReconciled?: (team: Team, completion: DialogCompletion) => void | Promise<void>;
}

/** One-step team creation: name it and pick its members in the same modal. */
export default function CreateTeamDialog({
  workspaceId,
  open,
  onOpenChange,
  onCreated,
  onReconciled,
}: CreateTeamDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const [name, setName] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isCreating, setIsCreating] = useState(false);
  const showSpinner = useDelayedFlag(isCreating);
  const { sessionKey, capture, invalidate, bindSession } = useDialogSession(open, workspaceId);

  const [previousSession, setPreviousSession] = useState(sessionKey);
  if (previousSession !== sessionKey) {
    setPreviousSession(sessionKey);
    setName("");
    setMemberSearch("");
    setSelectedIds(new Set());
    setIsCreating(false);
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) invalidate();
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setName("");
      setMemberSearch("");
      setSelectedIds(new Set());
    }
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
    if (!trimmed || isCreating) return;
    const completion = capture();
    setIsCreating(true);
    try {
      const team = await TeamsService.create(workspaceId, { name: trimmed });
      if (!completion.isAccountCurrent()) return;
      // The server adds the creator to a new team as admin; re-adding them
      // here would upsert that role back down to member.
      const memberIds = [...selectedIds].filter((id) => id !== user?.id);
      let added = 0;
      if (memberIds.length > 0) {
        const { failures } = await addTeamMembers(team.id, memberIds);
        added = memberIds.length - failures.length;
        if (failures.length > 0 && completion.isCurrent()) {
          toast({
            title: t("notes.spaces.members.addFailed", {
              failed: failures.length,
              total: memberIds.length,
            }),
            variant: "destructive",
          });
        }
      }
      // +1: the creator's server-added admin row.
      const created = { ...team, member_count: added + 1 };
      if (completion.isAccountCurrent()) await onReconciled?.(created, completion);
      if (!completion.isCurrent()) return;
      await onCreated?.(created);
      if (completion.isCurrent()) handleOpenChange(false);
    } catch (err) {
      if (!completion.isCurrent()) return;
      toast({
        title: t("settingsPage.workspace.teams.couldNotCreate"),
        description: err instanceof Error ? err.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      if (completion.isCurrent()) setIsCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settingsPage.workspace.teams.createTitle")}</DialogTitle>
        </DialogHeader>

        <div ref={bindSession} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="create-team-name" className="text-xs font-medium">
              {t("settingsPage.workspace.teams.nameLabel")}
            </Label>
            <Input
              dir="auto"
              id="create-team-name"
              value={name}
              autoFocus
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreate();
              }}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground/50">
              {t("settingsPage.workspace.teams.addMembersLabel")}
            </label>
            <TeamMemberPicker
              key={sessionKey}
              open={open}
              workspaceId={workspaceId}
              currentUserId={user?.id}
              capture={capture}
              search={memberSearch}
              onSearchChange={setMemberSearch}
              onSelect={toggleMember}
              selectedIds={selectedIds}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isCreating}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void handleCreate()} disabled={!name.trim() || isCreating}>
            {showSpinner && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
            {t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// This reader mounts inside the Portal, after its form's session ref attaches.
// A parent Effect can run while Radix is still deferring the Portal children.
function TeamMemberPicker({
  open,
  workspaceId,
  currentUserId,
  capture,
  search,
  onSearchChange,
  onSelect,
  selectedIds,
}: {
  open: boolean;
  workspaceId: string;
  currentUserId?: string;
  capture: () => DialogCompletion;
  search: string;
  onSearchChange: (value: string) => void;
  onSelect: (member: WorkspaceMember) => void;
  selectedIds: Set<string>;
}) {
  const { t } = useTranslation();
  const { members: roster, refreshMembers } = useWorkspaceStore(
    useShallow((s) => ({
      members: s.membersByWorkspace[workspaceId] ?? EMPTY_WORKSPACE_MEMBERS,
      refreshMembers: s.refreshMembers,
    }))
  );
  const [membersError, setMembersError] = useState(false);
  const [rosterLoaded, setRosterLoaded] = useState(false);
  const loadMembers = useCallback(async () => {
    const completion = capture();
    setMembersError(false);
    setRosterLoaded(false);
    try {
      await refreshMembers(workspaceId);
      if (completion.isCurrent()) setRosterLoaded(true);
    } catch {
      if (completion.isCurrent()) setMembersError(true);
    }
  }, [refreshMembers, workspaceId, capture]);
  useEffect(() => {
    if (open) void loadMembers();
  }, [open, loadMembers]);
  const candidates = useMemo(
    () => (rosterLoaded ? orderMemberCandidates(roster, currentUserId) : []),
    [roster, rosterLoaded, currentUserId]
  );
  if (membersError)
    return (
      <div className="rounded border border-border/70 dark:border-border-subtle/60 px-3 py-2.5 flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {t("settingsPage.workspace.members.loadError")}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void loadMembers()}
          className="h-6 px-2 text-xs shrink-0"
        >
          {t("settingsPage.workspace.loadError.retry")}
        </Button>
      </div>
    );
  if (!rosterLoaded)
    return <div className="h-24 rounded bg-foreground/5 dark:bg-white/5 animate-pulse" />;
  return (
    <MemberPickList
      members={candidates}
      search={search}
      onSearchChange={onSearchChange}
      onSelect={onSelect}
      selectedIds={selectedIds}
      currentUserId={currentUserId}
    />
  );
}
