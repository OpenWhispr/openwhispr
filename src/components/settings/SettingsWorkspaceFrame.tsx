import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Users, UserPlus, Loader2 } from "../icons";
import { Button } from "../ui/button";
import CreateWorkspaceDialog from "../CreateWorkspaceDialog";
import InviteTeammateDialog from "../InviteTeammateDialog";
import type { Workspace } from "../../types/electron";
import type { SettingsWorkspaceState } from "./useSettingsWorkspace";

interface Props {
  state: SettingsWorkspaceState;
  children: (workspace: Workspace) => React.ReactNode;
}

/**
 * The loading, error and empty states shared by the workspace settings pages. The page itself
 * renders only once a workspace is ready.
 */
export default function SettingsWorkspaceFrame({
  state,
  children,
}: Props): React.ReactElement | null {
  const { t } = useTranslation();
  const { status, workspace, workspaces, retry, loading, stale, signedOut } = state;
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteWorkspaceId, setInviteWorkspaceId] = useState<string | null>(null);

  if (signedOut) return null;

  // Shared by the empty and ready branches so the create→invite chain
  // survives the branch switch when the first workspace lands in the store.
  const inviteWorkspace = inviteWorkspaceId
    ? (workspaces.find((w) => w.id === inviteWorkspaceId) ?? null)
    : null;
  const createDialog = (
    <>
      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={setInviteWorkspaceId}
      />
      {inviteWorkspace && (
        <InviteTeammateDialog
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setInviteWorkspaceId(null);
          }}
          workspaceId={inviteWorkspace.id}
          workspaceName={inviteWorkspace.name}
          cancelLabel={t("common.skip")}
        />
      )}
    </>
  );

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
        {status === "error" ? (
          <div className="rounded-lg border border-border/70 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 p-6 text-center">
            <p className="text-xs font-medium text-foreground mb-1">
              {t("settingsPage.workspace.loadError.title")}
            </p>
            <p className="text-xs text-muted-foreground mb-4">
              {t("settingsPage.workspace.loadError.description")}
            </p>
            {retryButton}
          </div>
        ) : (
          <div className="rounded-lg border border-border/70 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 p-6 text-center">
            <Users className="w-5 h-5 text-muted-foreground/70 mx-auto mb-2" />
            <p className="text-xs font-medium text-foreground mb-1">
              {t("settingsPage.workspace.empty.title")}
            </p>
            <p className="text-xs text-muted-foreground mb-4">
              {t("settingsPage.workspace.empty.description")}
            </p>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <UserPlus className="me-1.5 h-3.5 w-3.5" />
              {t("settingsPage.workspace.empty.create")}
            </Button>
          </div>
        )}
        {createDialog}
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
      {createDialog}
    </div>
  );
}
