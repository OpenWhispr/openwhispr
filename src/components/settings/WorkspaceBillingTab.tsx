import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "../ui/button";
import { useToast } from "../ui/useToast";
import { WorkspacesService } from "../../services/WorkspacesService";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { Workspace } from "../../types/electron";

interface Props {
  workspace: Workspace;
}

export default function WorkspaceBillingTab({ workspace }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const refresh = useWorkspaceStore((s) => s.refresh);
  const isOwner = workspace.role === "owner";
  const [busy, setBusy] = useState(false);
  const [seatsUsed, setSeatsUsed] = useState<number | null>(null);
  const focusCleanupRef = useRef<(() => void) | null>(null);

  const loadSeats = useCallback(async () => {
    try {
      // Server truth: billable members + pending invites.
      const preview = await WorkspacesService.previewSeats(workspace.id, 1);
      setSeatsUsed(preview.next_quantity - 1);
    } catch {
      // No subscription yet or insufficient role — fall back to the member count.
      try {
        const members = await WorkspacesService.listMembers(workspace.id);
        setSeatsUsed(members.length);
      } catch {
        setSeatsUsed(null);
      }
    }
  }, [workspace.id]);

  useEffect(() => {
    setSeatsUsed(null);
    void loadSeats();
  }, [loadSeats]);

  useEffect(() => () => focusCleanupRef.current?.(), []);

  // The user finishes checkout / the portal in the browser; refresh when they return.
  function refreshOnReturn() {
    focusCleanupRef.current?.();
    const onFocus = () => {
      focusCleanupRef.current = null;
      void refresh();
      void loadSeats();
    };
    window.addEventListener("focus", onFocus, { once: true });
    focusCleanupRef.current = () => window.removeEventListener("focus", onFocus);
  }

  async function openBilling(getUrl: () => Promise<string>) {
    setBusy(true);
    try {
      const url = await getUrl();
      window.electronAPI?.openExternal?.(url) ?? window.open(url, "_blank");
      refreshOnReturn();
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

  const seatsTotal = Math.max(workspace.seats, seatsUsed ?? 0);
  const pct =
    seatsUsed === null || seatsTotal === 0 ? 0 : Math.min(100, (seatsUsed / seatsTotal) * 100);

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
              {t(`settingsPage.workspace.billing.planLabel.${workspace.plan}`, {
                defaultValue: workspace.plan,
              })}
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

        <div className="pt-1">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-muted-foreground">
              {t("settingsPage.workspace.billing.seats")}
            </span>
            <span className="text-foreground font-medium">
              {seatsUsed ?? "–"} / {seatsTotal}
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
      </div>

      {isOwner && (
        <div className="flex gap-2">
          {workspace.stripe_subscription_id ? (
            <Button
              onClick={() => openBilling(() => WorkspacesService.billingPortal(workspace.id))}
              disabled={busy}
              size="sm"
              variant="outline"
            >
              {busy ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              )}
              {busy
                ? t("settingsPage.workspace.billing.opening")
                : t("settingsPage.workspace.billing.manageStripe")}
            </Button>
          ) : (
            <Button
              onClick={() =>
                openBilling(() => WorkspacesService.billingCheckout(workspace.id, "monthly"))
              }
              disabled={busy}
              size="sm"
            >
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {busy
                ? t("settingsPage.workspace.billing.opening")
                : t("settingsPage.workspace.billing.startSubscription")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
