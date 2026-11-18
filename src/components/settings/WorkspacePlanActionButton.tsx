import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "../icons";
import { Button } from "../ui/button";
import { useToast } from "../ui/useToast";
import { openAdminConsole } from "../../lib/auth";
import type { WorkspacePlanAction } from "../../lib/workspaceBilling";
import { useBillingRefreshOnReturn } from "../../hooks/useBillingRefreshOnReturn";
import { WorkspacesService } from "../../services/WorkspacesService";
import { useWorkspaceStore } from "../../stores/workspaceStore";

const CONTACT_SALES_URL = "https://openwhispr.com/contact-sales";

interface Props {
  action: WorkspacePlanAction;
  label: string;
  variant?: "default" | "outline";
  onRefreshEntitlement?: () => Promise<void>;
}

async function openUrl(url: string): Promise<void> {
  if (window.electronAPI?.openExternal) await window.electronAPI.openExternal(url);
  else window.open(url, "_blank");
}

/** A Plans grid button that acts on a workspace's plan rather than the personal one. */
export function WorkspacePlanActionButton({
  action,
  label,
  variant = "outline",
  onRefreshEntitlement,
}: Props): React.ReactElement {
  const { t } = useTranslation();
  const { toast } = useToast();
  const refresh = useWorkspaceStore((s) => s.refresh);
  const refreshOnReturn = useBillingRefreshOnReturn(() => {
    void refresh({ fresh: true });
    void onRefreshEntitlement?.();
  });
  const [opening, setOpening] = useState(false);

  async function handleClick(): Promise<void> {
    setOpening(true);
    try {
      if (action.kind === "stripePortal") {
        await openUrl(await WorkspacesService.billingPortal(action.workspaceId));
        refreshOnReturn();
      } else if (action.kind === "console") {
        await openAdminConsole();
      } else {
        await openUrl(CONTACT_SALES_URL);
      }
    } catch (error) {
      toast({
        title: t("common.error"),
        description: error instanceof Error ? error.message : t("common.unknownError"),
        variant: "destructive",
      });
    } finally {
      setOpening(false);
    }
  }

  return (
    <Button
      onClick={() => void handleClick()}
      disabled={opening}
      variant={variant}
      size="sm"
      className="w-full h-6 text-[10px]"
    >
      {opening ? <Loader2 size={10} className="animate-spin" /> : label}
    </Button>
  );
}
