import React from "react";
import { useTranslation } from "react-i18next";

interface EnterpriseReadinessRecoveryProps {
  onRetry: () => void;
  onSelectWorkspace?: (workspaceId: string) => void;
  onSignOut: () => void;
  workspaces?: ReadonlyArray<{ id: string; name: string }>;
}

export function EnterpriseReadinessRecovery({
  onRetry,
  onSelectWorkspace,
  onSignOut,
  workspaces = [],
}: EnterpriseReadinessRecoveryProps): React.ReactElement {
  const { t } = useTranslation();
  const canSelectWorkspace = workspaces.length > 0 && Boolean(onSelectWorkspace);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="max-w-sm text-center space-y-4">
        {canSelectWorkspace ? (
          <div className="space-y-2">
            <h1 className="text-base font-semibold text-foreground">
              {t("workspaces.switcher.workspaces")}
            </h1>
            <div className="grid gap-2">
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  className="rounded-md border border-border px-3 py-2 text-sm text-foreground hover:bg-muted"
                  onClick={() => onSelectWorkspace?.(workspace.id)}
                >
                  {workspace.name}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <h1 className="text-base font-semibold text-foreground">
              {t("settingsPage.workspace.loadError.title")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("settingsPage.workspace.loadError.description")}
            </p>
          </div>
        )}
        <div className="flex justify-center gap-2">
          <button type="button" className="text-sm text-primary" onClick={onRetry}>
            {t("settingsPage.workspace.loadError.retry")}
          </button>
          <button type="button" className="text-sm text-muted-foreground" onClick={onSignOut}>
            {t("settingsPage.account.signOut.signOut")}
          </button>
        </div>
      </div>
    </div>
  );
}
