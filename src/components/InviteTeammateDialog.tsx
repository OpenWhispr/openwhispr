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
import { WorkspacesService, type SeatPreview } from "../services/WorkspacesService";
import { formatAmount } from "../utils/formatAmount";
import { useToast } from "./ui/useToast";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName: string;
  onInvited?: () => void;
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
  const [seatPreview, setSeatPreview] = useState<SeatPreview | null>(null);
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const seats = workspace?.seats ?? null;
  // A subscribed workspace already at capacity bills a seat if this invite is
  // accepted. Say so before sending. Both sides of the
  // comparison come from the same preview so a stale store can't misprice it.
  const addsBilledSeat =
    seatPreview !== null && seatPreview.seats_used >= seatPreview.current_quantity;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    WorkspacesService.previewSeats(workspaceId, 1)
      .then((preview) => {
        if (cancelled) return;
        setSeatPreview(preview);
        setSeatsUsed(preview.seats_used);
      })
      .catch(async () => {
        // Free workspace — the preview needs a subscription. Fall back to the
        // member count so the seat line still renders, with nothing to bill.
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
      setSeatPreview(null);
    }
  }, [open, initialEmail]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    try {
      const result = await InvitationsService.send(workspaceId, {
        email: email.trim().toLowerCase(),
        role,
        ...(teamIds && teamIds.length > 0 ? { team_ids: teamIds } : {}),
      });
      if (result.email_sent) {
        toast({
          title: t("workspaces.invite.sentTitle"),
          description: t("workspaces.invite.sentDescription", { email }),
        });
      } else {
        toast({
          title: t("workspaces.invite.sentNoEmailTitle"),
          description: t("workspaces.invite.sentNoEmailDescription", { email }),
          variant: "destructive",
        });
      }
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

          {addsBilledSeat && (
            <p className="text-[11px] text-muted-foreground">
              {t("workspaces.invite.seatCost", {
                amount: formatAmount(seatPreview.amount_due, seatPreview.currency),
              })}
            </p>
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
