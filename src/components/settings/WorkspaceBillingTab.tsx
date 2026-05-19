import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { Button } from "../ui/button";
import { useToast } from "../ui/useToast";
import { WorkspacesService } from "../../services/WorkspacesService";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { Workspace } from "../../types/electron";

interface Props {
  workspace: Workspace;
}

const PLAN_LABELS: Record<string, string> = {
  business: "Business",
  pro: "Pro",
  free: "Free",
};

export default function WorkspaceBillingTab({ workspace }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const members = useWorkspaceStore((s) => s.members);
  const isOwner = workspace.role === "owner";
  const [busy, setBusy] = useState(false);

  const seatsUsed = members.length;
  const seatsTotal = Math.max(workspace.seats, seatsUsed);
  const pct = seatsTotal === 0 ? 0 : Math.min(100, (seatsUsed / seatsTotal) * 100);

  async function handleCheckout() {
    setBusy(true);
    try {
      const url = await WorkspacesService.billingCheckout(workspace.id, "monthly");
      window.electronAPI?.openExternal?.(url) ?? window.open(url, "_blank");
    } catch (error) {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handlePortal() {
    setBusy(true);
    try {
      const url = await WorkspacesService.billingPortal(workspace.id);
      window.electronAPI?.openExternal?.(url) ?? window.open(url, "_blank");
    } catch (error) {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold text-foreground">
          {t("settingsPage.workspace.billing.title")}
        </h3>
        <p className="text-xs text-muted-foreground/80 mt-0.5">
          {t("settingsPage.workspace.billing.description")}
        </p>
      </div>

      <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
              {t("settingsPage.workspace.billing.plan")}
            </p>
            <p className="text-base font-semibold text-foreground">
              {PLAN_LABELS[workspace.plan] || workspace.plan}
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
            {workspace.status}
          </span>
        </div>

        <div className="pt-1">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-muted-foreground">
              {t("settingsPage.workspace.billing.seats")}
            </span>
            <span className="text-foreground font-medium">
              {seatsUsed} / {seatsTotal}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-foreground/5 dark:bg-white/5 overflow-hidden">
            <div
              className="h-full bg-primary/70 dark:bg-primary/80"
              style={{ width: `${pct}%` }}
            />
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
      </div>

      {isOwner && (
        <div className="flex gap-2">
          {workspace.stripe_subscription_id ? (
            <Button onClick={handlePortal} disabled={busy} size="sm" variant="outline">
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              {t("settingsPage.workspace.billing.manageStripe")}
            </Button>
          ) : (
            <Button onClick={handleCheckout} disabled={busy} size="sm">
              {t("settingsPage.workspace.billing.startSubscription")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
