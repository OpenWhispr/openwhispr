import { TeamsService } from "./TeamsService";
import { SpacesService } from "./SpacesService";
import { markSpacePurged, releasePurgedSpace, syncService, upsertCloudSpaces } from "./SyncService";
import {
  getAccountGeneration,
  hideSpaceInView,
  loadSpaces,
  purgeSpace,
  updateSpaceMeta,
} from "../stores/noteStore";
import { holdSpace, markHeldSpaceDeleted, releaseSpace } from "../lib/heldSpaceDeletes";
import { holdTeam, releaseTeam } from "../lib/heldTeamDeletes";
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
  deleteHold: {
    accountGeneration: getAccountGeneration,
    hide: (space, cloudSpaceId) => {
      holdSpace(space.id, cloudSpaceId);
      return hideSpaceInView(space.id);
    },
    release: (space, cloudSpaceId) => releaseSpace(space.id, cloudSpaceId),
    markDeleted: (space) => markHeldSpaceDeleted(space.id),
  },
  teamDeleteHold: { hide: holdTeam, release: releaseTeam },
});

export const {
  createSpace,
  renameSpace,
  deleteSpace,
  holdSpaceDelete,
  commitHeldDeletes,
  createTeam,
  addPeopleToTeam,
  renameTeam,
  holdTeamDelete,
  assignTeamToSpace,
  assignTeamToSpaces,
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

window.addEventListener("beforeunload", commitHeldDeletes);
