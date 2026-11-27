import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "../icons";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import { useToast } from "../ui/useToast";
import { openAdminConsole } from "../../lib/auth";
import { CONTACT_SALES_URL } from "../../lib/contactSales";
import type { WorkspacePlanAction } from "../../lib/workspaceBilling";
import { useBillingRefreshOnReturn } from "../../hooks/useBillingRefreshOnReturn";
import { WorkspacesService } from "../../services/WorkspacesService";
import { useWorkspaceStore } from "../../stores/workspaceStore";

interface Props {
  action: WorkspacePlanAction;
  label: string;
  variant?: "default" | "outline" | "ghost";
  /** Replaces the default compact sizing; merged over the variant's classes. */
  className?: string;
  /** Sizes the spinner to the button it replaces the label in. */
  spinnerClassName?: string;
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
  className = "w-full h-6 text-[10px]",
  spinnerClassName,
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
      className={className}
    >
      {opening ? <Loader2 size={10} className={cn("animate-spin", spinnerClassName)} /> : label}
    </Button>
  );
}
