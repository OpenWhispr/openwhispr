import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { cn } from "./lib/utils";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { InvitationsService } from "../services/InvitationsService";
import { TeamsService } from "../services/TeamsService";
import { useToast } from "./ui/useToast";
import type { Team } from "../types/electron";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName: string;
  onInvited?: () => void;
}

export default function InviteTeammateDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  onInvited,
}: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeams, setSelectedTeams] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const refreshTeams = useWorkspaceStore((s) => s.refreshTeams);

  useEffect(() => {
    if (!open) return;
    TeamsService.list(workspaceId)
      .then(setTeams)
      .catch(() => setTeams([]));
  }, [open, workspaceId]);

  useEffect(() => {
    if (!open) {
      setEmail("");
      setRole("member");
      setSelectedTeams(new Set());
    }
  }, [open]);

  function toggleTeam(id: string) {
    setSelectedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    try {
      await InvitationsService.send(workspaceId, {
        email: email.trim().toLowerCase(),
        role,
        team_ids: Array.from(selectedTeams),
      });
      toast({
        title: t("workspaces.invite.sentTitle"),
        description: t("workspaces.invite.sentDescription", { email }),
      });
      void refreshTeams(workspaceId);
      onInvited?.();
      onOpenChange(false);
    } catch (error) {
      toast({
        title: t("workspaces.invite.errorTitle"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("workspaces.invite.title", { workspace: workspaceName })}
          </DialogTitle>
          <DialogDescription>{t("workspaces.invite.description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email" className="text-xs font-medium">
              {t("workspaces.invite.emailLabel")}
            </Label>
            <Input
              id="invite-email"
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
              required
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-medium">{t("workspaces.invite.roleLabel")}</Label>
            <div className="flex gap-1.5">
              {(["member", "admin"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRole(r)}
                  className={cn(
                    "flex-1 h-9 px-3 rounded-md border text-xs font-medium transition-colors",
                    "outline-none focus-visible:ring-1 focus-visible:ring-primary/30",
                    role === r
                      ? "border-primary/40 bg-primary/8 text-foreground"
                      : "border-border/60 text-muted-foreground hover:bg-foreground/4 hover:text-foreground"
                  )}
                >
                  {t(`workspaces.invite.role.${r}`)}
                </button>
              ))}
            </div>
          </div>

          {teams.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("workspaces.invite.teamsLabel")}</Label>
              <div className="flex flex-wrap gap-1.5">
                {teams.map((team) => {
                  const checked = selectedTeams.has(team.id);
                  return (
                    <button
                      key={team.id}
                      type="button"
                      onClick={() => toggleTeam(team.id)}
                      className={cn(
                        "h-7 px-2.5 rounded-md border text-xs transition-colors outline-none",
                        "focus-visible:ring-1 focus-visible:ring-primary/30",
                        checked
                          ? "border-primary/40 bg-primary/8 text-foreground"
                          : "border-border/60 text-muted-foreground hover:bg-foreground/4 hover:text-foreground"
                      )}
                    >
                      {team.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <DialogFooter className="pt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!email.trim() || submitting}>
              {submitting ? t("workspaces.invite.submitting") : t("workspaces.invite.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
