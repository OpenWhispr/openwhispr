import React from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "../icons";
import { Button } from "../ui/button";
import type { Workspace } from "../../types/electron";
import type { SettingsWorkspaceState } from "./useSettingsWorkspace";

interface Props {
  state: SettingsWorkspaceState;
  children: (workspace: Workspace) => React.ReactNode;
}

/**
 * The loading, error and unavailable states shared by the workspace settings pages. The page
 * itself renders only once a workspace is ready.
 */
export default function SettingsWorkspaceFrame({
  state,
  children,
}: Props): React.ReactElement | null {
  const { t } = useTranslation();
  const { status, workspace, retry, loading, stale, signedOut } = state;

  if (signedOut) return null;

  if (status === "loading") {
    return (
      <div className="space-y-3">
        <div className="h-6 w-32 rounded bg-foreground/5 dark:bg-white/5 animate-pulse" />
        <div className="h-24 rounded-lg bg-foreground/5 dark:bg-white/5 animate-pulse" />
      </div>
    );
  }

  const retryButton = (
    <Button size="sm" variant="outline" onClick={retry} disabled={loading}>
      {loading && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
      {t("settingsPage.workspace.loadError.retry")}
    </Button>
  );

  if (status !== "ready" || !workspace) {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-xs font-semibold text-foreground">
            {t("settingsPage.workspace.title")}
          </h3>
          <p className="text-xs text-muted-foreground/80 mt-0.5">
            {t("settingsPage.workspace.description")}
          </p>
        </div>
        {/* Unavailable: the list holds no default workspace yet; Retry asks the server for it. */}
        <div className="rounded-lg border border-border/70 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 p-6 text-center">
          <p className="text-xs font-medium text-foreground mb-1">
            {status === "error"
              ? t("settingsPage.workspace.loadError.title")
              : t("workspaces.switcher.unavailable")}
          </p>
          <p className="text-xs text-muted-foreground mb-4">
            {t("settingsPage.workspace.loadError.description")}
          </p>
          {retryButton}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* The last refresh failed, so this is the list from memory or the cache. */}
      {stale && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-border/70 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 px-3 py-2"
        >
          <p className="flex-1 text-xs text-muted-foreground">
            {t("settingsPage.workspace.staleList")}
          </p>
          {retryButton}
        </div>
      )}
      {children(workspace)}
    </div>
  );
}
