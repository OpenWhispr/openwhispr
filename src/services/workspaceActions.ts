import { WorkspacesService } from "./WorkspacesService";
import { clearCachedLeaderboards } from "../lib/insightsCache";
import { syncService } from "./SyncService";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { createWorkspaceActions } from "./workspaceActionsCore";
import { rosterFor } from "../lib/peopleRoster";

// Single path for leaving, deleting and transferring a workspace, and removing members: server call
// → workspace store refresh → sync request. The orchestration lives in an
// injectable core so ordering and failure behavior stay testable.
const actions = createWorkspaceActions({
  api: WorkspacesService,
  store: {
    // Leaving or deleting a workspace changes which leaderboards the account can see.
    forgetWorkspace: (id) => {
      clearCachedLeaderboards();
      useWorkspaceStore.getState().forgetWorkspace(id);
    },
    refresh: (options) => useWorkspaceStore.getState().refresh(options),
    refreshMembers: (workspaceId) => {
      clearCachedLeaderboards();
      return useWorkspaceStore.getState().refreshMembers(workspaceId);
    },
    // An account switch empties the list without an error, which must not read as "not listed".
    listedWorkspaceIds: () => {
      const { loaded, error, workspaces } = useWorkspaceStore.getState();
      return loaded && !error ? workspaces.map((w) => w.id) : null;
    },
    memberRole: (workspaceId, userId) =>
      rosterFor(useWorkspaceStore.getState(), workspaceId).find((m) => m.user_id === userId)
        ?.role ?? null,
  },
  sync: syncService,
  notifyUsageChanged: () => window.dispatchEvent(new Event("usage-changed")),
});

export const { leaveWorkspace, deleteWorkspace, transferOwnership, removeMembers } = actions;
