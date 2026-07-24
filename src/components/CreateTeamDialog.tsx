import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { useToast } from "./ui/useToast";
import MemberPickList from "./MemberPickList";
import { TeamsService } from "../services/TeamsService";
import { addTeamMembers } from "../services/spaceActions";
import { orderMemberCandidates } from "../lib/memberCandidates";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useAuth } from "../hooks/useAuth";
import { useDelayedFlag } from "../hooks/useDelayedFlag";
import type { Team, WorkspaceMember } from "../types/electron";

interface CreateTeamDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires after the team (and any picked members) exist on the server. */
  onCreated?: (team: Team) => void | Promise<void>;
}

/** One-step team creation: name it and pick its members in the same modal. */
export default function CreateTeamDialog({
  workspaceId,
  open,
  onOpenChange,
  onCreated,
}: CreateTeamDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { members: roster, refreshMembers } = useWorkspaceStore(
    useShallow((s) => ({ members: s.members, refreshMembers: s.refreshMembers }))
  );
  const [name, setName] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [membersError, setMembersError] = useState(false);
  const [rosterLoaded, setRosterLoaded] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const showSpinner = useDelayedFlag(isCreating);

  useEffect(() => {
    if (!open) return;
    setMembersError(false);
    setRosterLoaded(false);
    refreshMembers(workspaceId)
      .then(() => setRosterLoaded(true))
      .catch(() => setMembersError(true));
  }, [open, workspaceId, refreshMembers]);

  const candidates = useMemo(
    () => (rosterLoaded ? orderMemberCandidates(roster, user?.id) : []),
    [roster, rosterLoaded, user?.id]
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
    setIsCreating(true);
    try {
      const team = await TeamsService.create(workspaceId, { name: trimmed });
      // The server adds the creator to a new team as admin; re-adding them
      // here would upsert that role back down to member.
      const memberIds = [...selectedIds].filter((id) => id !== user?.id);
      let added = 0;
      if (memberIds.length > 0) {
        const { failures } = await addTeamMembers(team.id, memberIds);
        added = memberIds.length - failures.length;
        if (failures.length > 0) {
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
      await onCreated?.({ ...team, member_count: added + 1 });
      handleOpenChange(false);
    } catch (err) {
      toast({
        title: t("settingsPage.workspace.teams.couldNotCreate"),
        description: err instanceof Error ? err.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settingsPage.workspace.teams.createTitle")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="create-team-name" className="text-xs font-medium">
              {t("settingsPage.workspace.teams.nameLabel")}
            </Label>
            <Input
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
            {membersError ? (
              <div className="rounded border border-border/70 dark:border-border-subtle/50 px-3 py-2.5 flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {t("settingsPage.workspace.members.loadError")}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setMembersError(false);
                    refreshMembers(workspaceId)
                      .then(() => setRosterLoaded(true))
                      .catch(() => setMembersError(true));
                  }}
                  className="h-6 px-2 text-xs shrink-0"
                >
                  {t("settingsPage.workspace.loadError.retry")}
                </Button>
              </div>
            ) : !rosterLoaded ? (
              <div className="h-24 rounded bg-foreground/5 dark:bg-white/5 animate-pulse" />
            ) : (
              <MemberPickList
                members={filteredCandidates}
                search={memberSearch}
                onSearchChange={setMemberSearch}
                onSelect={toggleMember}
                selectedIds={selectedIds}
                currentUserId={user?.id}
              />
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isCreating}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void handleCreate()} disabled={!name.trim() || isCreating}>
            {showSpinner && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
