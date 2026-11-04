import { TeamsService } from "./TeamsService";
import { SpacesService } from "./SpacesService";
import { markSpacePurged, releasePurgedSpace, syncService, upsertCloudSpaces } from "./SyncService";
import { loadSpaces, purgeSpace, updateSpaceMeta } from "../stores/noteStore";
import { invalidateSpaceRoster } from "../lib/spaceRosterCache";
import { createSpaceActions } from "./spaceActionsCore";

// Single mutation path for spaces, their direct members, and their assigned
// teams: server call → local SQLite mirror → store refresh. The orchestration
// lives in an injectable core so ordering, rollback, and partial-failure
// behavior stay testable without a renderer or cloud server.
const actions = createSpaceActions({
  teams: TeamsService,
  spaces: SpacesService,
  local: {
    upsertSpaceFromCloud: async (space) =>
      (await window.electronAPI.upsertSpaceFromCloud?.(space)) ?? null,
    setSpaceSyncStatus: async (id, status) => {
      await window.electronAPI.setSpaceSyncStatus?.(id, status);
    },
    updateSpaceMeta,
    purgeSpace,
    loadSpaces,
    getSpaces: async () => (await window.electronAPI.getSpaces?.()) ?? [],
  },
  mirror: { upsertCloudSpaces },
  sync: syncService,
  markSpacePurged,
  releasePurgedSpace,
  invalidateSpaceRoster,
});

export const {
  createSpace,
  renameSpace,
  deleteSpace,
  restoreSpace,
  assignTeamToSpace,
  setSpaceTeamAccess,
  unassignTeamFromSpace,
  joinSpace,
  addPeopleToSpace,
  setSpaceAccessFlags,
  localSpaceIdFor,
  setSpaceMemberRole,
  removeSpaceMember,
  leaveSpace,
  requestSpacesResync,
  addTeamMembers,
  removeTeamMember,
  setTeamMemberRole,
  leaveTeam,
  deleteTeam,
} = actions;
