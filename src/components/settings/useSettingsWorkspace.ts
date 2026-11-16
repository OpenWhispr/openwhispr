import { useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useAuth } from "../../hooks/useAuth";
import { useRetryDefaultWorkspace } from "../../hooks/useWorkspace";
import { settingsWorkspace } from "../../lib/workspaceSwitcher";
import type { Workspace } from "../../types/electron";

// "unavailable": listed, but the default workspace isn't there yet.
export type SettingsWorkspaceStatus = "loading" | "error" | "unavailable" | "ready";

export interface SettingsWorkspaceState {
  status: SettingsWorkspaceStatus;
  /** The active workspace, or the first one when the active id is gone. */
  workspace: Workspace | null;
  workspaces: Workspace[];
  /** Reads the list again, or for an empty list asks the server for the default workspace. */
  retry: () => void;
  /** A refresh or a request for the default is in flight (Retry shows a spinner). */
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

  const { retry: retryDefault, retrying } = useRetryDefaultWorkspace();

  const workspace = settingsWorkspace(workspaces, activeWorkspaceId);
  const status: SettingsWorkspaceStatus = !loaded
    ? "loading"
    : workspaces.length === 0
      ? error
        ? "error"
        : "unavailable"
      : "ready";

  const retry = useCallback(() => {
    if (status === "unavailable") retryDefault();
    else void refresh();
  }, [status, retryDefault, refresh]);

  return {
    status,
    workspace: status === "ready" ? workspace : null,
    workspaces,
    retry,
    loading: loading || retrying,
    stale: status === "ready" && error,
    signedOut: !isSignedIn,
  };
}
