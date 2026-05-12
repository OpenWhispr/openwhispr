import { create } from "zustand";
import type { Workspace, WorkspaceMember, Team } from "../types/electron";
import { WorkspacesService } from "../services/WorkspacesService";
import { TeamsService } from "../services/TeamsService";
import logger from "../utils/logger";

interface WorkspaceState {
  workspaces: Workspace[];
  loaded: boolean;
  loading: boolean;
  activeWorkspaceId: string | null;
  members: WorkspaceMember[];
  teams: Team[];

  setActiveWorkspaceId: (id: string | null) => void;
  refresh: () => Promise<void>;
  createWorkspace: (name: string) => Promise<Workspace>;
  refreshMembers: (workspaceId: string) => Promise<void>;
  refreshTeams: (workspaceId: string) => Promise<void>;
  current: () => Workspace | null;
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

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  loaded: false,
  loading: false,
  activeWorkspaceId: readActiveWorkspaceId(),
  members: [],
  teams: [],

  setActiveWorkspaceId: (id) => {
    writeActiveWorkspaceId(id);
    set({ activeWorkspaceId: id, members: [], teams: [] });
  },

  refresh: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const workspaces = await WorkspacesService.list();
      const activeId = get().activeWorkspaceId;
      const stillValid = activeId && workspaces.some((w) => w.id === activeId);
      set({
        workspaces,
        loaded: true,
        loading: false,
        activeWorkspaceId: stillValid ? activeId : null,
      });
      if (!stillValid && activeId) writeActiveWorkspaceId(null);
    } catch (error) {
      logger.error("Failed to load workspaces", { error: (error as Error).message }, "workspaces");
      set({ loading: false, loaded: true });
    }
  },

  createWorkspace: async (name) => {
    const workspace = await WorkspacesService.create(name);
    set((s) => ({ workspaces: [...s.workspaces, workspace] }));
    return workspace;
  },

  refreshMembers: async (workspaceId) => {
    try {
      const members = await WorkspacesService.listMembers(workspaceId);
      set({ members });
    } catch (error) {
      logger.error(
        "Failed to load workspace members",
        { error: (error as Error).message },
        "workspaces"
      );
    }
  },

  refreshTeams: async (workspaceId) => {
    try {
      const teams = await TeamsService.list(workspaceId);
      set({ teams });
    } catch (error) {
      logger.error(
        "Failed to load workspace teams",
        { error: (error as Error).message },
        "workspaces"
      );
    }
  },

  current: () => {
    const { activeWorkspaceId, workspaces } = get();
    if (!activeWorkspaceId) return null;
    return workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  },
}));
