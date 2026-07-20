import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Users, Trash2, Loader2 } from "lucide-react";
import { createTeamSpace, deleteTeamSpace } from "../../services/teamSpaceActions";
import { loadSpaces, useSpaces } from "../../stores/noteStore";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { useToast } from "../ui/useToast";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import DeleteSpaceDialog from "../notes/DeleteSpaceDialog";
import type { SpaceItem, Workspace } from "../../types/electron";

interface Props {
  workspace: Workspace;
}

export default function WorkspaceTeamsTab({ workspace }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const spaces = useSpaces();
  const teams = useMemo(
    () => spaces.filter((s) => s.kind === "team" && s.workspace_id === workspace.id),
    [spaces, workspace.id]
  );
  const [spacesLoaded, setSpacesLoaded] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const showCreateSpinner = useDelayedFlag(submitting);
  const [deleteTarget, setDeleteTarget] = useState<SpaceItem | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const canManage = workspace.role === "owner" || workspace.role === "admin";

  // The settings surface can open before the notes tree ever loads spaces.
  useEffect(() => {
    void loadSpaces().finally(() => setSpacesLoaded(true));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await createTeamSpace(workspace.id, { name: trimmed });
      setName("");
      setCreateOpen(false);
    } catch (error) {
      toast({
        title: t("notes.spaces.couldNotCreate"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function performDelete(space: SpaceItem) {
    setDeletingId(space.id);
    try {
      const result = await deleteTeamSpace(space);
      if (!result.success) {
        toast({
          title: t("notes.spaces.couldNotDelete"),
          description: result.error ?? t("common.unknownError"),
          variant: "destructive",
        });
        return;
      }
      toast({ title: t("notes.spaces.deleted", { space: space.name }) });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-semibold text-foreground">
            {t("settingsPage.workspace.teams.title")}
          </h3>
          <p className="text-xs text-muted-foreground/80 mt-0.5">
            {t("settingsPage.workspace.teams.description")}
          </p>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t("settingsPage.workspace.teams.new")}
          </Button>
        )}
      </div>

      {!spacesLoaded && teams.length === 0 ? (
        <div className="h-24 rounded-lg bg-foreground/5 dark:bg-white/5 animate-pulse" />
      ) : (
        <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 divide-y divide-border/30 dark:divide-border-subtle/50 bg-card/50 dark:bg-surface-2/50">
          {teams.length === 0 && (
            <div className="py-10 text-center">
              <Users className="w-5 h-5 text-muted-foreground/60 mx-auto mb-2" />
              <p className="text-xs text-muted-foreground mb-3">
                {t("settingsPage.workspace.teams.empty")}
              </p>
              {canManage && (
                <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
                  {t("settingsPage.workspace.teams.createFirst")}
                </Button>
              )}
            </div>
          )}
          {teams.map((team) => {
            const isDeleting = deletingId === team.id;
            return (
              <div key={team.id} className="flex items-center gap-3 px-4 h-14">
                {team.emoji && (
                  <span className="text-[13px] leading-none shrink-0" aria-hidden="true">
                    {team.emoji}
                  </span>
                )}
                <p className="flex-1 min-w-0 text-xs font-medium text-foreground truncate">
                  {team.name}
                </p>
                <span className="text-xs text-muted-foreground">
                  {t("settingsPage.workspace.teams.memberCount", {
                    count: team.member_count ?? 0,
                  })}
                </span>
                {canManage && (
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(team)}
                    disabled={isDeleting}
                    aria-label={t("notes.spaces.deleteSpace")}
                    className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/8 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-primary/30 disabled:pointer-events-none"
                  >
                    {isDeleting ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("settingsPage.workspace.teams.createTitle")}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="team-name" className="text-xs font-medium">
                {t("settingsPage.workspace.teams.nameLabel")}
              </Label>
              <Input
                id="team-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                maxLength={80}
                required
              />
            </div>
            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setCreateOpen(false)}
                disabled={submitting}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!name.trim() || submitting}>
                {showCreateSpinner && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {submitting ? t("workspaces.create.submitting") : t("common.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DeleteSpaceDialog
        space={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={(space) => void performDelete(space)}
      />
    </div>
  );
}
