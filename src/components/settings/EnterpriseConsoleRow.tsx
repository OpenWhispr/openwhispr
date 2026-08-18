import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "../ui/button";
import { openAdminConsole } from "../../lib/auth";
import { isEnterpriseConsoleAvailable } from "../../lib/workspaceBilling";
import type { Workspace } from "../../types/electron";

/**
 * Entry point to the web admin console (admin.openwhispr.com) for
 * owners/admins of an Enterprise workspace. Renders nothing otherwise.
 */
export default function EnterpriseConsoleRow({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation();
  const [opening, setOpening] = useState(false);

  if (!isEnterpriseConsoleAvailable(workspace)) return null;

  async function handleOpen() {
    setOpening(true);
    try {
      await openAdminConsole();
    } finally {
      setOpening(false);
    }
  }

  return (
    <div className="rounded-md border border-border/50 dark:border-border-subtle/60 bg-card/30 dark:bg-surface-2/30 p-3 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0">
        <ShieldCheck className="h-4 w-4 text-primary shrink-0" />
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">
            {t("settingsPage.workspace.enterpriseConsole.title")}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {t("settingsPage.workspace.enterpriseConsole.description")}
          </p>
        </div>
      </div>
      <Button
        onClick={() => void handleOpen()}
        disabled={opening}
        size="sm"
        variant="outline"
        className="shrink-0"
      >
        {opening ? (
          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : (
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
        )}
        {t("settingsPage.workspace.enterpriseConsole.open")}
      </Button>
    </div>
  );
}
