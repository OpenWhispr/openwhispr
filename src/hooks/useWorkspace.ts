import { useEffect } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useAuth } from "./useAuth";
import type { Workspace, WorkspaceRole } from "../types/electron";

// Focus fires on every switch back to the app, so a server that keeps failing would otherwise get
// a request each time. Shared by every mounted caller, which all listen.
const FOCUS_RETRY_INTERVAL_MS = 30_000;
let lastFocusRetryAt = 0;

interface UseWorkspaceResult {
  workspaces: Workspace[];
  active: Workspace | null;
  role: WorkspaceRole | null;
  loaded: boolean;
  setActive: (id: string | null) => void;
  refresh: () => Promise<void>;
}

export function useWorkspace(): UseWorkspaceResult {
  const { isSignedIn } = useAuth();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const loaded = useWorkspaceStore((s) => s.loaded);
  const error = useWorkspaceStore((s) => s.error);
  const refresh = useWorkspaceStore((s) => s.refresh);
  const setActive = useWorkspaceStore((s) => s.setActiveWorkspaceId);

  useEffect(() => {
    if (isSignedIn && !loaded) {
      void refresh();
    }
  }, [isSignedIn, loaded, refresh]);

  // A list that failed while offline would otherwise stay failed until the
  // user presses Retry. refresh() dedupes, so every mounted caller can listen.
  useEffect(() => {
    if (!isSignedIn || !error) return;
    const retry = (): void => void refresh();
    const retryOnFocus = (): void => {
      const now = Date.now();
      if (now - lastFocusRetryAt < FOCUS_RETRY_INTERVAL_MS) return;
      lastFocusRetryAt = now;
      retry();
    };
    window.addEventListener("online", retry);
    window.addEventListener("focus", retryOnFocus);
    return () => {
      window.removeEventListener("online", retry);
      window.removeEventListener("focus", retryOnFocus);
    };
  }, [isSignedIn, error, refresh]);

  const active = activeWorkspaceId
    ? (workspaces.find((w) => w.id === activeWorkspaceId) ?? null)
    : null;

  return {
    workspaces,
    active,
    role: active?.role ?? null,
    loaded,
    setActive,
    refresh,
  };
}
