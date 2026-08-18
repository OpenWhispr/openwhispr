import { create } from "zustand";
import type { Workspace, WorkspaceMember } from "../types/electron";
import { WorkspacesService } from "../services/WorkspacesService";
import logger from "../utils/logger";
import { usePolicyStore } from "./policyStore";
import { useEnterpriseIdentityStore } from "./enterpriseIdentityStore";

interface WorkspaceState {
  workspaces: Workspace[];
  loaded: boolean;
  loading: boolean;
  error: boolean;
  activeWorkspaceId: string | null;
  members: WorkspaceMember[];

  setActiveWorkspaceId: (id: string | null) => void;
  resetForAccountChange: () => void;
  refresh: () => Promise<void>;
  createWorkspace: (name: string) => Promise<Workspace>;
  refreshMembers: (workspaceId: string) => Promise<void>;
}

const ACTIVE_WORKSPACE_KEY = "activeWorkspaceId";

function readActiveWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACTIVE_WORKSPACE_KEY);
}

function writeActiveWorkspaceId(id: string | null): void {
  if (typeof window === "undefined") return;
  if (id) localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
  else localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
}

let refreshPromise: Promise<void> | null = null;
let membersRequestSeq = 0;
let accountGeneration = 0;

/**
 * Managed enterprise config is keyed by account + workspace + auth generation, so it has to be
 * re-resolved whenever any of the three changes. Callers that already know the account identity
 * pass it in; the active workspace comes from this store.
 */
export function refreshManagedEnterpriseIdentity(
  accountId: string | null,
  authGeneration: number | null,
  workspaceId: string | null = useWorkspaceStore.getState().activeWorkspaceId
): void {
  const enterprise = useEnterpriseIdentityStore.getState();
  if (!workspaceId || !accountId || authGeneration == null) {
    enterprise.clear();
    return;
  }
  if (
    enterprise.workspaceId !== workspaceId ||
    enterprise.accountId !== accountId ||
    enterprise.authGeneration !== authGeneration
  ) {
    enterprise.clear();
  }
  void enterprise.refresh(accountId, workspaceId, authGeneration);
}

function refreshForWorkspace(workspaceId: string | null): void {
  const { accountId, authGeneration } = usePolicyStore.getState();
  refreshManagedEnterpriseIdentity(accountId, authGeneration, workspaceId);
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  loaded: false,
  loading: false,
  error: false,
  activeWorkspaceId: readActiveWorkspaceId(),
  members: [],

  setActiveWorkspaceId: (id) => {
    writeActiveWorkspaceId(id);
    // Invalidate in-flight member fetches so the old workspace's roster can't
    // land under the new one.
    membersRequestSeq++;
    set({ activeWorkspaceId: id, members: [] });
    refreshForWorkspace(id);
  },

  resetForAccountChange: () => {
    accountGeneration += 1;
    membersRequestSeq += 1;
    // Let the next account start its own request. The identity check in the
    // old request prevents its result/finally block from touching new state.
    refreshPromise = null;
    writeActiveWorkspaceId(null);
    useEnterpriseIdentityStore.getState().clear();
    set({
      workspaces: [],
      loaded: false,
      loading: false,
      error: false,
      activeWorkspaceId: null,
      members: [],
    });
  },

  refresh: () => {
    if (refreshPromise) return refreshPromise;
    const generation = accountGeneration;
    set({ loading: true });
    let request!: Promise<void>;
    request = (async () => {
      try {
        const workspaces = await WorkspacesService.list();
        if (generation !== accountGeneration) return;
        const activeId = get().activeWorkspaceId;
        const stillValid = activeId && workspaces.some((w) => w.id === activeId);
        const resolvedActiveId = stillValid
          ? activeId
          : workspaces.length === 1
            ? workspaces[0].id
            : null;
        set({
          workspaces,
          loaded: true,
          loading: false,
          error: false,
          activeWorkspaceId: resolvedActiveId,
        });
        if (resolvedActiveId !== activeId) writeActiveWorkspaceId(resolvedActiveId);
        refreshForWorkspace(resolvedActiveId);
      } catch (error) {
        if (generation !== accountGeneration) return;
        logger.error(
          "Failed to load workspaces",
          { error: (error as Error).message },
          "workspaces"
        );
        set({ loading: false, loaded: true, error: true });
      } finally {
        if (refreshPromise === request) refreshPromise = null;
      }
    })();
    refreshPromise = request;
    return request;
  },

  createWorkspace: async (name) => {
    const generation = accountGeneration;
    const workspace = await WorkspacesService.create(name);
    if (generation === accountGeneration) {
      set((s) => ({ workspaces: [...s.workspaces, workspace] }));
    }
    return workspace;
  },

  refreshMembers: async (workspaceId) => {
    const seq = ++membersRequestSeq;
    try {
      const members = await WorkspacesService.listMembers(workspaceId);
      // Discard stale responses when a newer request targets another workspace.
      if (seq !== membersRequestSeq) return;
      set({ members });
    } catch (error) {
      logger.error(
        "Failed to load workspace members",
        { error: (error as Error).message },
        "workspaces"
      );
      throw error;
    }
  },
}));
