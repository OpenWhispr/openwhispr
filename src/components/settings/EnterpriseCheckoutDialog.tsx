import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Mail } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { useToast } from "../ui/useToast";
import { CloudApiError } from "../../services/cloudApi";
import { WorkspacesService, type EnterpriseUpgradePreview } from "../../services/WorkspacesService";
import { useBillingRefreshOnReturn } from "../../hooks/useBillingRefreshOnReturn";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
  canSelfServeEnterprise,
  canUpgradeWorkspaceToEnterprise,
} from "../../lib/workspaceBilling";
import { formatAmount } from "../../utils/formatAmount";
import { openExternalLink } from "../../utils/externalLinks";
import type { Workspace } from "../../types/electron";

const SEAT_LIMIT = 500;
const CONTACT_SALES_URL = "https://openwhispr.com/contact-sales";

// The API's coded billing refusals, localized; uncoded errors fall back to
// the server's own message.
const BILLING_ERROR_KEYS: Record<string, string> = {
  workspace_already_enterprise: "settingsPage.enterpriseCheckout.errors.alreadyEnterprise",
  workspace_subscription_inactive: "settingsPage.enterpriseCheckout.errors.subscriptionInactive",
  price_not_configured: "settingsPage.enterpriseCheckout.errors.priceNotConfigured",
};

function billingErrorMessage(error: unknown, t: ReturnType<typeof useTranslation>["t"]): string {
  const key =
    error instanceof CloudApiError && error.code ? BILLING_ERROR_KEYS[error.code] : undefined;
  if (key) return t(key);
  return error instanceof Error && error.message ? error.message : t("common.unknownError");
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: Workspace[];
  onRefreshEntitlement?: () => Promise<void> | void;
}

export default function EnterpriseCheckoutDialog({
  open,
  onOpenChange,
  workspaces,
  onRefreshEntitlement,
}: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const refresh = useWorkspaceStore((s) => s.refresh);
  const armRefreshOnReturn = useBillingRefreshOnReturn(() => {
    void refresh();
    void onRefreshEntitlement?.();
  });

  // New workspaces go through Stripe Checkout; already-subscribed ones swap
  // the subscription price in place (no browser round-trip).
  const eligible = useMemo(
    () =>
      workspaces.filter(
        (workspace) =>
          canSelfServeEnterprise(workspace) || canUpgradeWorkspaceToEnterprise(workspace)
      ),
    [workspaces]
  );
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [billingInterval, setBillingInterval] = useState<"monthly" | "annual">("monthly");
  const [submitting, setSubmitting] = useState(false);
  const [upgradePreview, setUpgradePreview] = useState<EnterpriseUpgradePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);

  const selected = eligible.find((w) => w.id === workspaceId) ?? eligible[0] ?? null;
  const isUpgrade = selected !== null && canUpgradeWorkspaceToEnterprise(selected);
  const seatsInUse = Math.max(1, selected?.seats_used ?? 1);
  const [seats, setSeats] = useState(seatsInUse);

  useEffect(() => {
    if (open) {
      setWorkspaceId(null);
      setBillingInterval("monthly");
      setSeats(seatsInUse);
    }
    // Reset to defaults on every open; seatsInUse is read, not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset the seat count whenever the effective workspace changes.
  useEffect(() => {
    setSeats(seatsInUse);
    // seatsInUse is read, not watched: a store refresh landing mid-dialog must
    // not clobber a seat count the user already typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  // If a refresh raises the occupancy floor, lift the count to stay valid —
  // never lower a higher value the user chose.
  useEffect(() => {
    setSeats((current) => Math.max(current, seatsInUse));
  }, [seatsInUse]);

  const selectedId = selected?.id ?? null;
  useEffect(() => {
    setUpgradePreview(null);
    setPreviewError(null);
    if (!open || !isUpgrade || !selectedId) return;
    let stale = false;
    setPreviewLoading(true);
    WorkspacesService.previewEnterpriseUpgrade(selectedId)
      .then((preview) => {
        if (!stale) setUpgradePreview(preview);
      })
      .catch((error: unknown) => {
        if (!stale) setPreviewError(billingErrorMessage(error, t));
      })
      .finally(() => {
        if (!stale) setPreviewLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [open, isUpgrade, selectedId, previewAttempt, t]);

  const seatsValid = Number.isInteger(seats) && seats >= seatsInUse && seats <= SEAT_LIMIT;

  async function handleCheckout() {
    if (submitting || !selected || !seatsValid) return;
    setSubmitting(true);
    try {
      const url = await WorkspacesService.billingCheckout(selected.id, billingInterval, {
        tier: "enterprise",
        additionalSeats: seats - seatsInUse,
      });
      openExternalLink(url);
      armRefreshOnReturn();
      onOpenChange(false);
    } catch (error) {
      toast({
        title: t("common.error"),
        description: billingErrorMessage(error, t),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpgrade() {
    if (submitting || !selected) return;
    setSubmitting(true);
    try {
      await WorkspacesService.upgradeToEnterprise(selected.id);
      await refresh();
      await onRefreshEntitlement?.();
      toast({
        title: t("settingsPage.enterpriseCheckout.upgradedTitle"),
        description: t("settingsPage.enterpriseCheckout.upgradedDescription", {
          workspace: selected.name,
        }),
      });
      onOpenChange(false);
    } catch (error) {
      toast({
        title: t("common.error"),
        description: billingErrorMessage(error, t),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settingsPage.enterpriseCheckout.title")}</DialogTitle>
          <DialogDescription>
            {isUpgrade && selected
              ? t("settingsPage.enterpriseCheckout.upgradeDescription", {
                  workspace: selected.name,
                  plan: t(`settingsPage.workspace.billing.planLabel.${selected.plan}`, {
                    defaultValue: selected.plan,
                  }),
                })
              : eligible.length > 0
                ? t("settingsPage.enterpriseCheckout.description")
                : t("settingsPage.enterpriseCheckout.allSubscribed")}
          </DialogDescription>
        </DialogHeader>

        {eligible.length > 0 ? (
          <div className="space-y-4">
            {eligible.length > 1 && selected && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">
                  {t("settingsPage.enterpriseCheckout.workspaceLabel")}
                </Label>
                <Select value={selected.id} onValueChange={setWorkspaceId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {eligible.map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {isUpgrade ? (
              previewLoading ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              ) : upgradePreview ? (
                <>
                  <div className="rounded-lg border border-border/50 divide-y divide-border/40">
                    <div className="flex justify-between px-3 py-2 text-xs">
                      <span className="text-muted-foreground">
                        {t("settingsPage.enterpriseCheckout.proratedCharge")}
                      </span>
                      <span className="font-medium">
                        {formatAmount(upgradePreview.prorated_amount, upgradePreview.currency)}
                      </span>
                    </div>
                    <div className="flex justify-between px-3 py-2 text-xs">
                      <span className="text-muted-foreground">
                        {t("settingsPage.enterpriseCheckout.seatsLabel")}
                      </span>
                      <span className="font-medium">{upgradePreview.quantity}</span>
                    </div>
                    {upgradePreview.next_billing_date && (
                      <div className="flex justify-between px-3 py-2 text-xs">
                        <span className="text-muted-foreground">
                          {t("settingsPage.workspace.billing.nextInvoice")}
                        </span>
                        <span className="font-medium">
                          {new Date(upgradePreview.next_billing_date).toLocaleDateString()}
                        </span>
                      </div>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {t("settingsPage.enterpriseCheckout.prorationNote")}
                  </p>
                </>
              ) : previewError ? (
                <div className="space-y-2 rounded-lg border border-border/50 px-3 py-3">
                  <p className="text-xs font-medium">
                    {t("settingsPage.enterpriseCheckout.errors.previewFailed")}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{previewError}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPreviewAttempt((attempt) => attempt + 1)}
                  >
                    {t("common.retry")}
                  </Button>
                </div>
              ) : null
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="enterprise-seats" className="text-xs font-medium">
                    {t("settingsPage.enterpriseCheckout.seatsLabel")}
                  </Label>
                  <Input
                    id="enterprise-seats"
                    type="number"
                    min={seatsInUse}
                    max={SEAT_LIMIT}
                    value={seats}
                    onChange={(e) => setSeats(Number(e.target.value))}
                    aria-invalid={!seatsValid}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {t("settingsPage.enterpriseCheckout.seatsHint", { count: seatsInUse })}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium">
                    {t("settingsPage.enterpriseCheckout.intervalLabel")}
                  </Label>
                  <div className="flex gap-2">
                    {(["monthly", "annual"] as const).map((option) => (
                      <Button
                        key={option}
                        type="button"
                        size="sm"
                        variant={billingInterval === option ? "default" : "outline"}
                        onClick={() => setBillingInterval(option)}
                      >
                        {t(`settingsPage.enterpriseCheckout.interval.${option}`)}
                      </Button>
                    ))}
                  </div>
                </div>

                <p className="text-[11px] text-muted-foreground">
                  {t("settingsPage.enterpriseCheckout.priceNote")}
                </p>
              </>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          {eligible.length > 0 ? (
            isUpgrade ? (
              <Button
                size="sm"
                onClick={() => void handleUpgrade()}
                disabled={submitting || !upgradePreview}
              >
                {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {t("settingsPage.enterpriseCheckout.upgradeCta")}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => void handleCheckout()}
                disabled={submitting || !selected || !seatsValid}
              >
                {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {t("settingsPage.enterpriseCheckout.continueCta")}
              </Button>
            )
          ) : (
            <Button size="sm" onClick={() => window.electronAPI?.openExternal?.(CONTACT_SALES_URL)}>
              <Mail className="mr-1.5 h-3.5 w-3.5" />
              {t("settingsPage.account.pricing.enterprise.cta")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
