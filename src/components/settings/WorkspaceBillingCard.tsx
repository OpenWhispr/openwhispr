import React, { Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2, Plus, UserPlus } from "../icons";
import { Button } from "../ui/button";
import EnterpriseConsoleRow from "./EnterpriseConsoleRow";
import { useBillingRefreshOnReturn } from "../../hooks/useBillingRefreshOnReturn";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { useToast } from "../ui/useToast";
import { WorkspacesService, type SeatPreview } from "../../services/WorkspacesService";
import { CloudApiError } from "../../services/cloudApi";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { workspaceCan } from "../../lib/capabilities";
import {
  currentBillingIdentity,
  isSameBillingIdentity,
  type BillingIdentity,
} from "../../lib/billingRequestIdentity";
import { hasActiveWorkspaceSubscription, hasSubscription } from "../../lib/workspaceBilling";
import { freeWorkspaceCta } from "../../lib/workspacePeople";
import { useWorkspacePeopleCount } from "../../hooks/useWorkspacePeopleCount";
import { formatAmount } from "../../utils/formatAmount";
import type { Workspace } from "../../types/electron";

const InviteTeammateDialog = React.lazy(() => import("../InviteTeammateDialog"));

interface SeatQuote {
  preview: SeatPreview;
  identity: BillingIdentity;
}

interface Props {
  workspace: Workspace;
  onRefreshEntitlement?: () => Promise<void>;
  /** Shows the "View Personal plan" link beside a solo workspace's Pro hint. */
  onViewPersonal?: () => void;
}

export default function WorkspaceBillingCard({
  workspace,
  onRefreshEntitlement,
  onViewPersonal,
}: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const refresh = useWorkspaceStore((s) => s.refresh);
  const [busy, setBusy] = useState<"checkout" | "portal" | "preview" | "seats" | null>(null);
  const [seatQuote, setSeatQuote] = useState<SeatQuote | null>(null);
  // A quote for a workspace the card no longer shows is gone, so the dialog never shows it.
  const seatPreview =
    seatQuote && seatQuote.identity.workspaceId === workspace.id ? seatQuote.preview : null;
  // Read after an await: the card can be shown another workspace (same instance) or be gone.
  const workspaceIdRef = useRef(workspace.id);
  workspaceIdRef.current = workspace.id;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Coming back to the workspace must not reopen the quote it left.
  useEffect(() => {
    setSeatQuote((quote) => (quote && quote.identity.workspaceId !== workspace.id ? null : quote));
  }, [workspace.id]);
  const refreshOnReturn = useBillingRefreshOnReturn(() => {
    void refresh();
    void onRefreshEntitlement?.();
  });
  const canManageBilling = workspaceCan(workspace, "manage_billing");
  // Add seat and Manage in Stripe need a Stripe subscription, so they read the raw id:
  // `has_subscription` is also true for a paid plan provisioned without Stripe.
  const subscribed = Boolean(workspace.stripe_subscription_id);
  const canAddSeats = subscribed && hasActiveWorkspaceSubscription(workspace);
  // A plan OpenWhispr set up without Stripe: a checkout would only be refused (409).
  const provisioned = !subscribed && hasSubscription(workspace);
  const seatsUsed = workspace.seats_used ?? workspace.seats;
  const seatsTotal = Math.max(workspace.seats, seatsUsed);
  const pct = seatsTotal > 0 ? Math.min(100, (seatsUsed / seatsTotal) * 100) : 0;
  // Counted only when the answer picks the buttons, so a paid card sends no extra reads.
  const countsPeople = freeWorkspaceCta(workspace, null) === "pending";
  const { people, retry: retryPeople } = useWorkspacePeopleCount(
    countsPeople ? workspace.id : null
  );
  const freeCta = freeWorkspaceCta(workspace, people);
  // Bound to its workspace, so the dialog never invites into one the card no longer shows.
  const [inviteWorkspaceId, setInviteWorkspaceId] = useState<string | null>(null);

  async function openBilling(kind: "checkout" | "portal", getUrl: () => Promise<string>) {
    setBusy(kind);
    try {
      const url = await getUrl();
      if (window.electronAPI?.openExternal) await window.electronAPI.openExternal(url);
      else window.open(url, "_blank");
      refreshOnReturn();
    } catch (error) {
      toast({
        title: t("common.error"),
        description: billingErrorText(error),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  }

  function billingErrorText(error: unknown): string {
    if (error instanceof CloudApiError && error.code === "default_workspace_has_no_teammates") {
      return t("settingsPage.billing.errors.noTeammates");
    }
    return error instanceof Error ? error.message : t("common.unknownError");
  }

  function startBusinessCheckout(): void {
    void openBilling("checkout", () =>
      WorkspacesService.billingCheckout(workspace.id, "monthly", { tier: "business" })
    );
  }

  function renderInviteButton(variant: "default" | "outline"): React.ReactNode {
    return (
      <Button
        onClick={() => setInviteWorkspaceId(workspace.id)}
        disabled={busy !== null}
        size="sm"
        variant={variant}
      >
        <UserPlus className="me-1.5 h-3.5 w-3.5" />
        {t("settingsPage.billing.free.inviteTeammates")}
      </Button>
    );
  }

  function renderUpgradeButton(variant: "default" | "outline"): React.ReactNode {
    return (
      <Button onClick={startBusinessCheckout} disabled={busy !== null} size="sm" variant={variant}>
        {busy === "checkout" && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
        {t("settingsPage.billing.free.upgradeToBusiness")}
      </Button>
    );
  }

  function renderFreeActions(): React.ReactNode {
    switch (freeCta) {
      case "none":
        return null;
      case "pending":
        // Holds the buttons' height so the card doesn't jump when the count lands.
        return (
          <div className="pt-1">
            <div
              aria-hidden="true"
              className="h-8 w-56 max-w-full rounded-full bg-foreground/5 dark:bg-white/5 animate-pulse"
            />
          </div>
        );
      case "invite":
        return (
          <div className="space-y-2 pt-1">
            <div className="flex flex-wrap gap-2">
              {renderInviteButton("default")}
              {renderUpgradeButton("outline")}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settingsPage.billing.free.proHint", {
                price: t("settingsPage.account.pricing.pro.monthlyPrice"),
              })}
              {onViewPersonal && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={onViewPersonal}
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t("settingsPage.billing.free.viewPersonal")}
                  </button>
                </>
              )}
            </p>
          </div>
        );
      case "upgrade":
        return <div className="flex flex-wrap gap-2 pt-1">{renderUpgradeButton("default")}</div>;
      case "unknown":
        return (
          <div className="space-y-2 pt-1">
            <div className="flex flex-wrap gap-2">
              {renderInviteButton("outline")}
              {renderUpgradeButton("outline")}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settingsPage.billing.free.countFailed")}{" "}
              <button
                type="button"
                onClick={retryPeople}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {t("common.retry")}
              </button>
            </p>
          </div>
        );
    }
  }

  function isQuoteCurrent(identity: BillingIdentity): boolean {
    return (
      mountedRef.current &&
      isSameBillingIdentity(identity, currentBillingIdentity(workspaceIdRef.current))
    );
  }

  function showSeatUpdateFailed(): void {
    toast({ title: t("settingsPage.unifiedBilling.seatUpdateFailed"), variant: "destructive" });
  }

  async function previewSeatIncrease() {
    const identity = currentBillingIdentity(workspace.id);
    if (!identity) {
      showSeatUpdateFailed();
      return;
    }
    setBusy("preview");
    try {
      const preview = await WorkspacesService.previewSeats(
        workspace.id,
        1,
        identity.authGeneration
      );
      if (isQuoteCurrent(identity)) setSeatQuote({ preview, identity });
    } catch (error) {
      if (!mountedRef.current) return;
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
    if (!seatQuote) return;
    const { preview, identity } = seatQuote;
    if (identity.workspaceId === null || !isQuoteCurrent(identity)) {
      setSeatQuote(null);
      showSeatUpdateFailed();
      return;
    }
    setBusy("seats");
    try {
      await WorkspacesService.updateSeats(
        identity.workspaceId,
        preview.next_quantity,
        identity.authGeneration
      );
      setSeatQuote(null);
      await refresh({ fresh: true });
      toast({
        title: t("settingsPage.unifiedBilling.seatUpdated", {
          count: preview.next_quantity,
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
    <div className="rounded-lg border border-border/70 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p dir="auto" className="text-xs font-semibold text-foreground truncate">
            {workspace.name}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {t(`settingsPage.workspace.role.${workspace.role}`)}
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
          <span dir="ltr" className="text-foreground font-medium">
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
          <span dir="ltr" className="text-foreground">
            {new Date(workspace.current_period_end).toLocaleDateString()}
          </span>
        </div>
      )}

      {!canManageBilling ? (
        <p className="text-xs text-muted-foreground">
          {workspace.billing_manager
            ? t("settingsPage.unifiedBilling.managedBy", {
                owner: workspace.billing_manager,
              })
            : t("settingsPage.workspace.billing.ownerOnly")}
        </p>
      ) : provisioned ? (
        <p className="text-xs text-muted-foreground">
          {t("settingsPage.workspace.billing.provisionedPlan")}
        </p>
      ) : subscribed ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {canAddSeats && (
            <Button onClick={() => void previewSeatIncrease()} disabled={busy !== null} size="sm">
              {busy === "preview" ? (
                <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="me-1.5 h-3.5 w-3.5" />
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
              <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <ExternalLink className="me-1.5 h-3.5 w-3.5" />
            )}
            {t("settingsPage.workspace.billing.manageStripe")}
          </Button>
        </div>
      ) : (
        renderFreeActions()
      )}

      <EnterpriseConsoleRow workspace={workspace} />

      {inviteWorkspaceId === workspace.id && (
        <Suspense fallback={null}>
          <InviteTeammateDialog
            open
            onOpenChange={(open) => {
              if (!open) setInviteWorkspaceId(null);
            }}
            workspaceId={workspace.id}
            workspaceName={workspace.name}
            onInvitationsChanged={retryPeople}
          />
        </Suspense>
      )}

      <Dialog open={seatPreview !== null} onOpenChange={(open) => !open && setSeatQuote(null)}>
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
            <div className="rounded-lg border border-border/70 divide-y divide-border/60">
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
            <Button variant="outline" size="sm" onClick={() => setSeatQuote(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={() => void confirmSeatIncrease()}
              disabled={busy === "seats"}
            >
              {busy === "seats" && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
              {t("settingsPage.unifiedBilling.confirmSeats.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
