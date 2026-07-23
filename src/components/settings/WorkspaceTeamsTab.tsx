import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Users, Trash2, Loader2 } from "lucide-react";
import { deleteTeam } from "../../services/spaceActions";
import { TeamsService } from "../../services/TeamsService";
import { loadSpaces, useSpaces } from "../../stores/noteStore";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { useDialogs } from "../../hooks/useDialogs";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { useToast } from "../ui/useToast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  ConfirmDialog,
} from "../ui/dialog";
import TeamMembersDialog from "./TeamMembersDialog";
import type { Team, Workspace } from "../../types/electron";

interface Props {
  workspace: Workspace;
}

export default function WorkspaceTeamsTab({ workspace }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const spaces = useSpaces();
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamsLoaded, setTeamsLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const showCreateSpinner = useDelayedFlag(submitting);
  const [membersTeam, setMembersTeam] = useState<Team | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const canManage = workspace.role === "owner" || workspace.role === "admin";

  const loadTeams = useCallback(async () => {
    setLoadFailed(false);
    try {
      setTeams(await TeamsService.list(workspace.id));
    } catch {
      setLoadFailed(true);
    } finally {
      setTeamsLoaded(true);
    }
  }, [workspace.id]);

  // Spaces feed the "backs N spaces" column; the settings surface can open
  // before the notes tree ever loads them.
  useEffect(() => {
    void loadTeams();
    void loadSpaces();
  }, [loadTeams]);

  const backedSpacesByTeam = useMemo(() => {
    const counts = new Map<string, number>();
    for (const space of spaces) {
      if (space.kind !== "team") continue;
      for (const teamRef of space.teams) {
        counts.set(teamRef.id, (counts.get(teamRef.id) ?? 0) + 1);
      }
    }
    return counts;
  }, [spaces]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await TeamsService.create(workspace.id, { name: trimmed });
      await loadTeams();
      setName("");
      setCreateOpen(false);
    } catch (error) {
      toast({
        title: t("settingsPage.workspace.teams.couldNotCreate"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  function confirmDelete(team: Team) {
    const backedSpaces = backedSpacesByTeam.get(team.id) ?? 0;
    showConfirmDialog({
      title: t("settingsPage.workspace.teams.deleteConfirmTitle", { team: team.name }),
      description:
        backedSpaces > 0
          ? t("settingsPage.workspace.teams.deleteConfirmBacksSpaces", { count: backedSpaces })
          : t("settingsPage.workspace.teams.deleteConfirmDescription"),
      confirmText: t("common.delete"),
      variant: "destructive",
      onConfirm: async () => {
        setDeletingId(team.id);
        try {
          await deleteTeam(team.id);
          await loadTeams();
        } catch (error) {
          toast({
            title: t("common.error"),
            description: error instanceof Error ? error.message : t("common.unknownError"),
            variant: "destructive",
          });
        } finally {
          setDeletingId(null);
        }
      },
    });
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

      {!teamsLoaded ? (
        <div className="h-24 rounded-lg bg-foreground/5 dark:bg-white/5 animate-pulse" />
      ) : loadFailed && teams.length === 0 ? (
        <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 px-4 py-6 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {t("settingsPage.workspace.loadError.description")}
          </p>
          <Button variant="outline" size="sm" onClick={() => void loadTeams()}>
            {t("settingsPage.workspace.loadError.retry")}
          </Button>
        </div>
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
            const backedSpaces = backedSpacesByTeam.get(team.id) ?? 0;
            return (
              <div key={team.id} className="flex items-center gap-3 px-4 h-14">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">{team.name}</p>
                  {backedSpaces > 0 && (
                    <p className="text-xs text-muted-foreground/80 truncate">
                      {t("settingsPage.workspace.teams.backsSpaces", { count: backedSpaces })}
                    </p>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {t("settingsPage.workspace.teams.memberCount", {
                    count: team.member_count ?? 0,
                  })}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setMembersTeam(team)}
                  className="h-7 px-2 text-xs"
                >
                  <Users className="mr-1 h-3 w-3" />
                  {t("settingsPage.workspace.teams.membersButton")}
                </Button>
                {canManage && (
                  <button
                    type="button"
                    onClick={() => confirmDelete(team)}
                    disabled={isDeleting}
                    aria-label={t("common.delete")}
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

      {membersTeam && (
        <TeamMembersDialog
          team={membersTeam}
          workspace={workspace}
          open={!!membersTeam}
          onOpenChange={(open) => {
            if (!open) {
              setMembersTeam(null);
              void loadTeams();
            }
          }}
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
    </div>
  );
}
