import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Users } from "../icons";
import { cn } from "../lib/utils";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "./dialogButtons";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { useToast } from "../ui/useToast";
import { useBillingRefreshOnReturn } from "../../hooks/useBillingRefreshOnReturn";
import { hasValidatedAuthContext } from "../../lib/authRequestContext";
import { teamCreationFor, workspaceCan } from "../../lib/capabilities";
import { showsWorkspaceBillingCard } from "../../lib/workspaceBilling";
import { WorkspacesService } from "../../services/WorkspacesService";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { isolate } from "../../utils/bidiIsolate";
import type { Workspace } from "../../types/electron";

export interface TeamPaywallDialogProps {
  workspace: Workspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A fresh read says teams can be created after all; the host opens the form instead. */
  onAvailable?: () => void;
}

// The API's TEAM_PLANS: a workspace on one of these that can't create teams has a subscription
// that lapsed (past due, canceled), which checkout can't upgrade.
const TEAM_PLANS = new Set(["business", "enterprise"]);
const COPY = "settingsPage.workspace.teams.paywall";

/**
 * What a workspace that can't create teams sees when it tries: below Business, an upgrade; a
 * lapsed Business or Enterprise plan, a billing fix. `manage_billing` says who can act, and
 * everyone else is told who to ask.
 */
export default function TeamPaywallDialog({
  workspace,
  open,
  onOpenChange,
  onAvailable,
}: TeamPaywallDialogProps): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [startingCheckout, setStartingCheckout] = useState(false);
  const refreshOnReturn = useBillingRefreshOnReturn(() => {
    void useWorkspaceStore.getState().refresh({ fresh: true });
  });
  const canUpgrade = workspaceCan(workspace, "manage_billing");
  const owner = workspace.billing_manager;
  const lapsed = TEAM_PLANS.has(workspace.plan);
  const blocked = teamCreationFor(workspace) !== "allowed";
  // Plans & Billing hides an unpaid default workspace nobody else is in, so its owner buys
  // Business for it from here: the personal Business plan there doesn't unlock teams.
  const checkoutHere = !lapsed && !showsWorkspaceBillingCard(workspace);

  // The capability the paywall opened on may be stale (a plan changed on the web or another
  // device, or a webhook that landed late), so each opening reads the workspace again.
  useEffect(() => {
    if (open && hasValidatedAuthContext()) {
      void useWorkspaceStore.getState().refresh({ fresh: true });
    }
  }, [open]);
  // Hands over only after this opening saw creating blocked: a server refusal can open the
  // paywall while the list still says allowed, and handing over then would loop.
  const sawBlocked = useRef(false);
  useEffect(() => {
    if (!open) {
      sawBlocked.current = false;
      return;
    }
    if (blocked) sawBlocked.current = true;
    else if (sawBlocked.current) onAvailable?.();
  }, [open, blocked, onAvailable]);

  const startCheckout = async (): Promise<void> => {
    setStartingCheckout(true);
    try {
      const url = await WorkspacesService.billingCheckout(workspace.id, "monthly", {
        tier: "business",
      });
      if (window.electronAPI?.openExternal) await window.electronAPI.openExternal(url);
      else window.open(url, "_blank");
      refreshOnReturn();
      onOpenChange(false);
    } catch (error) {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setStartingCheckout(false);
    }
  };

  const handleUpgrade = (): void => {
    if (checkoutHere) {
      void startCheckout();
      return;
    }
    // A named section remounts Settings, so this also works from inside Settings.
    onOpenChange(false);
    void window.electronAPI?.openSettingsSection?.("plansBilling");
  };

  const variant = lapsed ? "lapsedBody" : "body";
  const body = canUpgrade
    ? t(`${COPY}.${variant}`)
    : owner
      ? t(`${COPY}.${variant}AskOwner`, { owner: isolate(owner) })
      : t(`${COPY}.${variant}AskOwnerUnknown`);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideCloseButton
        className="w-[330px] max-w-[calc(100vw-32px)] grid-cols-1 items-stretch gap-5 rounded-[28px] p-5 sm:max-w-[330px]"
      >
        <DialogHeader className="items-center gap-3 space-y-0 text-center sm:text-center">
          <div className="flex size-[42px] items-center justify-center rounded-full bg-surface-3 text-foreground">
            <Users className="size-3.5" aria-hidden="true" />
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <DialogTitle className="text-lg font-medium tracking-normal leading-snug">
              {t(lapsed ? `${COPY}.lapsedTitle` : `${COPY}.title`)}
            </DialogTitle>
            <DialogDescription className="text-sm leading-normal">{body}</DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {canUpgrade ? (
            <>
              <button
                type="button"
                onClick={handleUpgrade}
                disabled={startingCheckout}
                className={cn(PRIMARY_BUTTON, "flex-none")}
              >
                {startingCheckout && (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                )}
                {t(lapsed ? `${COPY}.updateBilling` : `${COPY}.upgrade`)}
              </button>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className={cn(SECONDARY_BUTTON, "flex-none")}
              >
                {t(`${COPY}.notNow`)}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className={cn(SECONDARY_BUTTON, "flex-none")}
            >
              {t("common.close")}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
