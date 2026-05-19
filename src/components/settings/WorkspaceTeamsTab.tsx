import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Users, Trash2 } from "lucide-react";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { TeamsService } from "../../services/TeamsService";
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
} from "../ui/dialog";
import type { Workspace, Team } from "../../types/electron";

interface Props {
  workspace: Workspace;
}

export default function WorkspaceTeamsTab({ workspace }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const teams = useWorkspaceStore((s) => s.teams);
  const refreshTeams = useWorkspaceStore((s) => s.refreshTeams);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const canManage = workspace.role === "owner" || workspace.role === "admin";

  useEffect(() => {
    void refreshTeams(workspace.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await TeamsService.create(workspace.id, {
        name: name.trim(),
        description: description.trim() || undefined,
      });
      await refreshTeams(workspace.id);
      setName("");
      setDescription("");
      setCreateOpen(false);
    } catch (error) {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(team: Team) {
    try {
      await TeamsService.remove(team.id);
      await refreshTeams(workspace.id);
    } catch (error) {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
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
        {teams.map((team) => (
          <div key={team.id} className="flex items-center gap-3 px-4 h-14">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground truncate">{team.name}</p>
              {team.description && (
                <p className="text-xs text-muted-foreground truncate">{team.description}</p>
              )}
            </div>
            <span className="text-xs text-muted-foreground">
              {t("settingsPage.workspace.teams.memberCount", { count: team.member_count ?? 0 })}
            </span>
            {canManage && (
              <button
                type="button"
                onClick={() => handleDelete(team)}
                aria-label={t("common.delete")}
                className="p-1 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/8 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

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
            <div className="space-y-1.5">
              <Label htmlFor="team-description" className="text-xs font-medium">
                {t("settingsPage.workspace.teams.descriptionLabel")}
              </Label>
              <Input
                id="team-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={280}
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
                {submitting ? t("common.saving") : t("common.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
