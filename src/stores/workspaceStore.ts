import { create } from "zustand";
import type { Workspace, WorkspaceMember } from "../types/electron";
import { WorkspacesService } from "../services/WorkspacesService";
import logger from "../utils/logger";

interface WorkspaceState {
  workspaces: Workspace[];
  loaded: boolean;
  loading: boolean;
  error: boolean;
  activeWorkspaceId: string | null;
  members: WorkspaceMember[];

  setActiveWorkspaceId: (id: string | null) => void;
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
  },

  refresh: () => {
    if (refreshPromise) return refreshPromise;
    set({ loading: true });
    refreshPromise = (async () => {
      try {
        const workspaces = await WorkspacesService.list();
        const activeId = get().activeWorkspaceId;
        const stillValid = activeId && workspaces.some((w) => w.id === activeId);
        set({
          workspaces,
          loaded: true,
          loading: false,
          error: false,
          activeWorkspaceId: stillValid ? activeId : null,
        });
        if (!stillValid && activeId) writeActiveWorkspaceId(null);
      } catch (error) {
        logger.error(
          "Failed to load workspaces",
          { error: (error as Error).message },
          "workspaces"
        );
        set({ loading: false, loaded: true, error: true });
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  },

  createWorkspace: async (name) => {
    const workspace = await WorkspacesService.create(name);
    set((s) => ({ workspaces: [...s.workspaces, workspace] }));
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
