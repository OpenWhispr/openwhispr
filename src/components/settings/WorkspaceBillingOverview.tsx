import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { clearSeatIntent, readSeatIntent, type SeatIntent } from "../../utils/billingSeatIntent";
import WorkspaceBillingCard from "./WorkspaceBillingCard";

export default function WorkspaceBillingOverview({
  onRefreshEntitlement,
}: {
  onRefreshEntitlement?: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { workspaces, activeWorkspaceId, loaded, error, refresh } = useWorkspaceStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      activeWorkspaceId: s.activeWorkspaceId,
      loaded: s.loaded,
      error: s.error,
      refresh: s.refresh,
    }))
  );
  const [seatIntent, setSeatIntent] = useState<SeatIntent | null>(() => readSeatIntent());

  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  const orderedWorkspaces = useMemo(() => {
    if (!activeWorkspaceId) return workspaces;
    return [...workspaces].sort((a, b) => {
      if (a.id === activeWorkspaceId) return -1;
      if (b.id === activeWorkspaceId) return 1;
      return 0;
    });
  }, [activeWorkspaceId, workspaces]);

  function consumeSeatIntent() {
    clearSeatIntent();
    setSeatIntent(null);
  }

  if (!loaded && workspaces.length === 0) {
    return (
      <div className="space-y-2">
        <div className="h-4 w-36 rounded bg-foreground/5 animate-pulse" />
        <div className="h-36 rounded-lg bg-foreground/5 animate-pulse" />
      </div>
    );
  }
  if (error || orderedWorkspaces.length === 0) return null;

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-xs font-semibold text-foreground">
          {t("settingsPage.unifiedBilling.workspaceTitle")}
        </h3>
        <p className="text-xs text-muted-foreground/80 mt-0.5">
          {t("settingsPage.unifiedBilling.workspaceDescription")}
        </p>
      </div>
      <div className="space-y-2">
        {orderedWorkspaces.map((workspace) => (
          <WorkspaceBillingCard
            key={workspace.id}
            workspace={workspace}
            requestedAdditionalSeats={
              seatIntent?.workspaceId === workspace.id ? seatIntent.additionalSeats : 0
            }
            onSeatIntentConsumed={
              seatIntent?.workspaceId === workspace.id ? consumeSeatIntent : undefined
            }
            onRefreshEntitlement={onRefreshEntitlement}
          />
        ))}
      </div>
    </section>
  );
}
