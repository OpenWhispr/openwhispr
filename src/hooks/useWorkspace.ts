import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ensureDefaultWorkspace, useWorkspaceStore } from "../stores/workspaceStore";
import { spacesInWorkspaceScope } from "../lib/workspaceSelection";
import { defaultWorkspaceName } from "../lib/workspaceSwitcher";
import { useAuth } from "./useAuth";
import type { SpaceItem, Workspace, WorkspaceRole } from "../types/electron";

// Focus fires on every switch back to the app, so a server that keeps failing would otherwise get
// a request each time. Shared by every mounted caller, which all listen.
const FOCUS_RETRY_INTERVAL_MS = 30_000;
let lastFocusRetryAt = 0;

interface UseWorkspaceResult {
  workspaces: Workspace[];
  active: Workspace | null;
  role: WorkspaceRole | null;
  loaded: boolean;
  /** The account's default workspace, where its existing private notes live. */
  defaultWorkspaceId: string | null;
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
  const defaultWorkspaceId = useWorkspaceStore((s) => s.defaultWorkspaceId);

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
    defaultWorkspaceId,
    setActive,
    refresh,
  };
}

export function useSpacesInWorkspaceScope(spaces: SpaceItem[]): SpaceItem[] {
  const { workspaces, active } = useWorkspace();
  // No Personal choice is left to put in place of the workspaces.
  return useMemo(
    () => spacesInWorkspaceScope(spaces, active?.id ?? null, workspaces, false),
    [spaces, active?.id, workspaces]
  );
}

/**
 * Has the server make the signed-in account's default workspace, named after the user, once a
 * list has loaded for the account (so the session is known to work). Mounted once, in the control
 * panel; ensureDefaultWorkspace asks once per account session and again after a failure, which the
 * next successful list read retries.
 */
export function useEnsureDefaultWorkspace(): void {
  const { t } = useTranslation();
  const { isSignedIn, isOfflineAccount, user } = useAuth();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const listed = useWorkspaceStore((s) => s.loaded && !s.error && s.listAccountId !== null);
  const name = defaultWorkspaceName(user?.name, t);

  useEffect(() => {
    if (!isSignedIn || isOfflineAccount || !listed) return;
    void ensureDefaultWorkspace(name);
  }, [isSignedIn, isOfflineAccount, listed, name, workspaces]);
}
