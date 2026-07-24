import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2, Plus } from "lucide-react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { useToast } from "../ui/useToast";
import { WorkspacesService } from "../../services/WorkspacesService";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { formatAmount } from "../../utils/formatAmount";
import type { Workspace } from "../../types/electron";

interface SeatPreview {
  next_quantity: number;
  current_quantity: number;
  seats_used: number;
  amount_due: number;
  currency: string;
}

interface Props {
  workspace: Workspace;
  requestedAdditionalSeats?: number;
  onSeatIntentConsumed?: () => void;
  onRefreshEntitlement?: () => Promise<void>;
}

export default function WorkspaceBillingCard({
  workspace,
  requestedAdditionalSeats = 0,
  onSeatIntentConsumed,
  onRefreshEntitlement,
}: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const refresh = useWorkspaceStore((s) => s.refresh);
  const [busy, setBusy] = useState<"checkout" | "portal" | "preview" | "seats" | null>(null);
  const [seatPreview, setSeatPreview] = useState<SeatPreview | null>(null);
  const focusCleanupRef = useRef<(() => void) | null>(null);
  const isOwner = workspace.role === "owner";
  const hasSubscription = Boolean(workspace.stripe_subscription_id);
  const canAddSeats =
    hasSubscription &&
    ["pro", "business", "enterprise"].includes(workspace.plan) &&
    ["active", "trialing"].includes(workspace.status);
  const seatsUsed = workspace.seats_used ?? workspace.seats;
  const seatsTotal = Math.max(workspace.seats, seatsUsed);
  const pct = seatsTotal > 0 ? Math.min(100, (seatsUsed / seatsTotal) * 100) : 0;

  useEffect(() => () => focusCleanupRef.current?.(), []);

  function refreshOnReturn() {
    focusCleanupRef.current?.();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const poll = () => {
      void refresh();
      void onRefreshEntitlement?.();
    };
    const onFocus = () => {
      poll();
      for (const delayMs of [4000, 8000, 16000]) timers.push(setTimeout(poll, delayMs));
    };
    window.addEventListener("focus", onFocus, { once: true });
    focusCleanupRef.current = () => {
      window.removeEventListener("focus", onFocus);
      timers.forEach(clearTimeout);
    };
  }

  async function openBilling(kind: "checkout" | "portal", getUrl: () => Promise<string>) {
    setBusy(kind);
    try {
      const url = await getUrl();
      if (window.electronAPI?.openExternal) await window.electronAPI.openExternal(url);
      else window.open(url, "_blank");
      onSeatIntentConsumed?.();
      refreshOnReturn();
    } catch (error) {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  async function previewSeatIncrease() {
    setBusy("preview");
    try {
      setSeatPreview(await WorkspacesService.previewSeats(workspace.id, 1));
    } catch (error) {
      toast({
        title: t("settingsPage.unifiedBilling.seatUpdateFailed"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  async function confirmSeatIncrease() {
    if (!seatPreview) return;
    setBusy("seats");
    try {
      await WorkspacesService.updateSeats(workspace.id, seatPreview.next_quantity);
      setSeatPreview(null);
      onSeatIntentConsumed?.();
      await refresh();
      toast({
        title: t("settingsPage.unifiedBilling.seatUpdated", {
          count: seatPreview.next_quantity,
        }),
      });
    } catch (error) {
      toast({
        title: t("settingsPage.unifiedBilling.seatUpdateFailed"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground truncate">{workspace.name}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {t(`settingsPage.workspace.role.${workspace.role}`)} · {workspace.slug}
          </p>
        </div>
        <span
          className={
            "text-[10px] font-medium px-2 py-0.5 rounded-md uppercase tracking-wide " +
            (workspace.status === "active" || workspace.status === "trialing"
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : workspace.status === "past_due"
                ? "bg-amber-500/12 text-amber-600 dark:text-amber-400"
                : "bg-foreground/8 text-foreground/65")
          }
        >
          {t(`settingsPage.workspace.billing.status.${workspace.status}`, {
            defaultValue: workspace.status,
          })}
        </span>
      </div>

      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
            {t("settingsPage.workspace.billing.plan")}
          </p>
          <p className="text-base font-semibold text-foreground">
            {t(`settingsPage.workspace.billing.planLabel.${workspace.plan}`, {
              defaultValue: workspace.plan,
            })}
          </p>
        </div>
        <p className="text-[10px] text-muted-foreground">
          {workspace.is_billable !== false
            ? t("settingsPage.unifiedBilling.billableSeat")
            : t("settingsPage.unifiedBilling.nonBillableSeat")}
        </p>
      </div>

      <div>
        <div className="flex items-center justify-between text-xs mb-1.5">
          <span className="text-muted-foreground">{t("settingsPage.workspace.billing.seats")}</span>
          <span className="text-foreground font-medium">
            {seatsUsed} / {seatsTotal}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-foreground/5 dark:bg-white/5 overflow-hidden">
          <div className="h-full bg-primary/70 dark:bg-primary/80" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {workspace.current_period_end && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t("settingsPage.workspace.billing.nextInvoice")}</span>
          <span className="text-foreground">
            {new Date(workspace.current_period_end).toLocaleDateString()}
          </span>
        </div>
      )}

      {!isOwner ? (
        <p className="text-xs text-muted-foreground">
          {workspace.billing_manager
            ? t("settingsPage.unifiedBilling.managedBy", {
                owner: workspace.billing_manager,
              })
            : t("settingsPage.workspace.billing.ownerOnly")}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2 pt-1">
          {hasSubscription ? (
            <>
              {canAddSeats && (
                <Button
                  onClick={() => void previewSeatIncrease()}
                  disabled={busy !== null}
                  size="sm"
                >
                  {busy === "preview" ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {t("settingsPage.unifiedBilling.addSeat")}
                </Button>
              )}
              <Button
                onClick={() =>
                  void openBilling("portal", () => WorkspacesService.billingPortal(workspace.id))
                }
                disabled={busy !== null}
                size="sm"
                variant="outline"
              >
                {busy === "portal" ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                )}
                {t("settingsPage.workspace.billing.manageStripe")}
              </Button>
            </>
          ) : (
            <Button
              onClick={() =>
                void openBilling("checkout", () =>
                  WorkspacesService.billingCheckout(
                    workspace.id,
                    "monthly",
                    requestedAdditionalSeats
                  )
                )
              }
              disabled={busy !== null}
              size="sm"
            >
              {busy === "checkout" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {requestedAdditionalSeats > 0
                ? t("settingsPage.unifiedBilling.startWithSeats", {
                    count: seatsUsed + requestedAdditionalSeats,
                  })
                : t("settingsPage.workspace.billing.startSubscription")}
            </Button>
          )}
        </div>
      )}

      <Dialog open={seatPreview !== null} onOpenChange={(open) => !open && setSeatPreview(null)}>
        <DialogContent className="sm:max-w-90">
          <DialogHeader>
            <DialogTitle>{t("settingsPage.unifiedBilling.confirmSeats.title")}</DialogTitle>
            <DialogDescription>
              {seatPreview &&
                t("settingsPage.unifiedBilling.confirmSeats.description", {
                  workspace: workspace.name,
                  count: seatPreview.next_quantity,
                })}
            </DialogDescription>
          </DialogHeader>
          {seatPreview && (
            <div className="rounded-lg border border-border/50 divide-y divide-border/40">
              <div className="flex justify-between px-3 py-2 text-xs">
                <span className="text-muted-foreground">
                  {t("settingsPage.unifiedBilling.confirmSeats.newCapacity")}
                </span>
                <span className="font-medium">{seatPreview.next_quantity}</span>
              </div>
              <div className="flex justify-between px-3 py-2 text-xs">
                <span className="text-muted-foreground">
                  {t("settingsPage.unifiedBilling.confirmSeats.chargeToday")}
                </span>
                <span className="font-medium">
                  {formatAmount(seatPreview.amount_due, seatPreview.currency)}
                </span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setSeatPreview(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={() => void confirmSeatIncrease()}
              disabled={busy === "seats"}
            >
              {busy === "seats" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("settingsPage.unifiedBilling.confirmSeats.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
