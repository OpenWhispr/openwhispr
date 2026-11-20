import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useBillingRefreshOnReturn } from "../../hooks/useBillingRefreshOnReturn";
import { WorkspacesService } from "../../services/WorkspacesService";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { Loader2 } from "../icons";
import { useToast } from "../ui/useToast";

interface Props {
  workspaceId: string;
  interval: "monthly" | "annual";
  className: string;
  onOpened?: () => void;
}

export function WorkspaceBusinessCheckoutButton({
  workspaceId,
  interval,
  className,
  onOpened,
}: Props): ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  useLayoutEffect(() => {
    return () => {
      // Dismissal or a workspace switch can happen while the checkout URL is in flight.
      pending.current = false;
    };
  }, []);
  const refreshOnReturn = useBillingRefreshOnReturn(() => {
    void useWorkspaceStore.getState().refresh({ fresh: true });
    window.dispatchEvent(new Event("usage-changed"));
  });

  async function startCheckout(): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const url = await WorkspacesService.billingCheckout(workspaceId, interval, {
        tier: "business",
      });
      if (!pending.current) return;
      if (window.electronAPI?.openExternal) {
        const result = await window.electronAPI.openExternal(url);
        if (!result.success)
          throw new Error(
            result.error || t("settingsPage.account.checkout.couldNotOpenDescription")
          );
      } else if (!window.open(url, "_blank")) {
        throw new Error(t("settingsPage.account.checkout.couldNotOpenDescription"));
      }
      refreshOnReturn();
      if (pending.current) onOpened?.();
    } catch (error) {
      if (pending.current) {
        toast({
          title: t("settingsPage.account.checkout.couldNotOpenTitle"),
          description: error instanceof Error ? error.message : t("common.unknownError"),
          variant: "destructive",
        });
      }
    } finally {
      if (pending.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={() => void startCheckout()}
    >
      {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
      {t("settingsPage.workspace.teams.paywall.upgrade")}
    </button>
  );
}
