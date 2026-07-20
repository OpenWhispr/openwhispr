import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
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
import { useDelayedFlag } from "../hooks/useDelayedFlag";
import { InvitationsService } from "../services/InvitationsService";
import { CloudApiError } from "../services/cloudApi";
import { WorkspacesService } from "../services/WorkspacesService";
import { useToast } from "./ui/useToast";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName: string;
  onInvited?: () => void;
  onNavigateToBilling?: () => void;
  cancelLabel?: string;
  /** Team spaces the invitee joins on accept (threaded into the invitation). */
  teamIds?: string[];
  initialEmail?: string;
}

export default function InviteTeammateDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  onInvited,
  onNavigateToBilling,
  cancelLabel,
  teamIds,
  initialEmail,
}: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [submitting, setSubmitting] = useState(false);
  const showSpinner = useDelayedFlag(submitting);
  const [seatsUsed, setSeatsUsed] = useState<number | null>(null);
  const [seatLimitSeats, setSeatLimitSeats] = useState<number | null>(null);
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const seats = workspace?.seats ?? null;
  const isOwner = workspace?.role === "owner";

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    WorkspacesService.previewSeats(workspaceId, 1)
      .then((preview) => {
        if (!cancelled) setSeatsUsed(preview.next_quantity - 1);
      })
      .catch(async () => {
        // No subscription yet — fall back to the member count so the seat
        // line always renders.
        try {
          const members = await WorkspacesService.listMembers(workspaceId);
          if (!cancelled) setSeatsUsed(members.length);
        } catch {
          if (!cancelled) setSeatsUsed(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId]);

  useEffect(() => {
    if (open) {
      if (initialEmail) setEmail(initialEmail);
    } else {
      setEmail("");
      setRole("member");
      setSeatsUsed(null);
      setSeatLimitSeats(null);
    }
  }, [open, initialEmail]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    setSeatLimitSeats(null);
    try {
      await InvitationsService.send(workspaceId, {
        email: email.trim().toLowerCase(),
        role,
        ...(teamIds && teamIds.length > 0 ? { team_ids: teamIds } : {}),
      });
      toast({
        title: t("workspaces.invite.sentTitle"),
        description: t("workspaces.invite.sentDescription", { email }),
      });
      onInvited?.();
      onOpenChange(false);
    } catch (error) {
      if (error instanceof CloudApiError && error.code === "seat_limit_reached") {
        const details = error.details as { seats?: number } | undefined;
        setSeatLimitSeats(details?.seats ?? seats ?? 0);
      } else {
        toast({
          title: t("workspaces.invite.errorTitle"),
          description: error instanceof Error ? error.message : t("common.unknownError"),
          variant: "destructive",
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("workspaces.invite.title", { workspace: workspaceName })}</DialogTitle>
          <DialogDescription>{t("workspaces.invite.description")}</DialogDescription>
          {seatsUsed !== null && seats !== null && (
            <p className="text-xs text-muted-foreground">
              {t("workspaces.invite.seatUsage", { used: seatsUsed, seats })}
            </p>
          )}
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
              placeholder={t("workspaces.invite.emailPlaceholder")}
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
                  aria-pressed={role === r}
                  onClick={() => setRole(r)}
                  className={cn(
                    "flex-1 px-3 py-2 rounded-md border text-left transition-colors",
                    "outline-none focus-visible:ring-1 focus-visible:ring-primary/30",
                    role === r
                      ? "border-primary/40 bg-primary/8"
                      : "border-border/60 hover:bg-foreground/4"
                  )}
                >
                  <span
                    className={cn(
                      "block text-xs font-medium",
                      role === r ? "text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {t(`workspaces.invite.role.${r}`)}
                  </span>
                  <span className="block text-[11px] text-muted-foreground mt-0.5">
                    {t(`workspaces.invite.roleDescription.${r}`)}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {seatLimitSeats !== null && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 flex items-center justify-between gap-3">
              <p className="text-xs text-destructive">
                {isOwner
                  ? t("workspaces.invite.seatLimit", { seats: seatLimitSeats })
                  : t("workspaces.invite.askOwner", { seats: seatLimitSeats })}
              </p>
              {isOwner && onNavigateToBilling && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    onOpenChange(false);
                    onNavigateToBilling();
                  }}
                >
                  {t("workspaces.invite.manageSeats")}
                </Button>
              )}
            </div>
          )}

          <DialogFooter className="pt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {cancelLabel ?? t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!email.trim() || submitting}>
              {showSpinner && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {submitting ? t("workspaces.invite.submitting") : t("workspaces.invite.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
