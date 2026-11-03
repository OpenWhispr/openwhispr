import { WorkspacesService } from "./WorkspacesService";
import { syncService } from "./SyncService";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { createWorkspaceActions } from "./workspaceActionsCore";

// Single path for leaving, deleting and transferring a workspace: server call
// → workspace store refresh → sync request. The orchestration lives in an
// injectable core so ordering and failure behavior stay testable.
const actions = createWorkspaceActions({
  api: WorkspacesService,
  store: {
    forgetWorkspace: (id) => useWorkspaceStore.getState().forgetWorkspace(id),
    refresh: (options) => useWorkspaceStore.getState().refresh(options),
    refreshMembers: (workspaceId) => useWorkspaceStore.getState().refreshMembers(workspaceId),
    // An account switch empties the list without an error, which must not read as "not listed".
    listedWorkspaceIds: () => {
      const { loaded, error, workspaces } = useWorkspaceStore.getState();
      return loaded && !error ? workspaces.map((w) => w.id) : null;
    },
    memberRole: (userId) =>
      useWorkspaceStore.getState().members.find((m) => m.user_id === userId)?.role ?? null,
  },
  sync: syncService,
  notifyUsageChanged: () => window.dispatchEvent(new Event("usage-changed")),
});

export const { leaveWorkspace, deleteWorkspace, transferOwnership } = actions;
