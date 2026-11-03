import { useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useAuth } from "../../hooks/useAuth";
import type { Workspace } from "../../types/electron";

export type SettingsWorkspaceStatus = "loading" | "error" | "empty" | "ready";

export interface SettingsWorkspaceState {
  status: SettingsWorkspaceStatus;
  /** The active workspace, or the first one when the active id is gone. */
  workspace: Workspace | null;
  workspaces: Workspace[];
  retry: () => void;
  /** A refresh is in flight (Retry shows a spinner). */
  loading?: boolean;
  /** The last refresh failed, so a ready list comes from memory or the cache. */
  stale?: boolean;
  signedOut?: boolean;
}

export function useSettingsWorkspace(): SettingsWorkspaceState {
  const { isSignedIn } = useAuth();
  const { workspaces, activeWorkspaceId, loaded, loading, error, refresh } = useWorkspaceStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      activeWorkspaceId: s.activeWorkspaceId,
      loaded: s.loaded,
      loading: s.loading,
      error: s.error,
      refresh: s.refresh,
    }))
  );

  useEffect(() => {
    if (isSignedIn && !loaded) void refresh();
  }, [isSignedIn, loaded, refresh]);

  const retry = useCallback(() => {
    void refresh();
  }, [refresh]);

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0] ?? null;
  const status: SettingsWorkspaceStatus = !loaded
    ? "loading"
    : workspaces.length === 0
      ? error
        ? "error"
        : "empty"
      : "ready";

  return {
    status,
    workspace: status === "ready" ? workspace : null,
    workspaces,
    retry,
    loading,
    stale: status === "ready" && error,
    signedOut: !isSignedIn,
  };
}
