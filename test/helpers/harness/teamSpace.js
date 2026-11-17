// Private notes stay on the device (D2), so tests of the note and folder sync
// machinery run it on the notes that still sync whole: a teamspace's. This
// mirrors one into a test device and its fake cloud.

const { localStorage } = require("./browserGlobals.js");

const TEAM_ACCOUNT = "user-harness";

const TEAM_SPACE = Object.freeze({
  id: "cloud-team-space",
  workspace_id: "workspace-team",
  name: "Team",
  slug: "team",
  description: null,
  emoji: null,
  my_role: "admin",
  my_direct_role: "admin",
  member_count: 1,
  teams: [],
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

// Signs the database in as the harness account (the one establishValidatedAuth
// validates), lists the teamspace in the fake cloud and mirrors it locally as
// already backfilled, so a pass runs no snapshot pull for it, on a device that
// has already probed for teamspaces (a push before any pass carries scope).
// With fileRowsHere (the default) the cloud files the notes and folders a test
// seeds without a scope into it, owned by the account. Returns the local space.
function joinTeamSpace(db, cloud, { accountId = TEAM_ACCOUNT, fileRowsHere = true } = {}) {
  if (db.activeAccountId !== accountId) db.setActiveAccountId(accountId);
  cloud?.seedSpace(TEAM_SPACE, fileRowsHere ? { fileRowsHere, ownerId: accountId } : {});
  const space = db.upsertSpaceFromCloud(TEAM_SPACE);
  db.setSpaceSyncStatus(space.id, "synced");
  localStorage.setItem("teamSpacesCapability", "true");
  return db.getSpace(space.id);
}

// db.saveNote, filed in a space (a teamspace's notes have no default folder).
function saveNoteIn(db, spaceId, title, content, noteType = "personal") {
  return db.saveNote(title, content, noteType, null, null, null, spaceId);
}

module.exports = { TEAM_ACCOUNT, TEAM_SPACE, joinTeamSpace, saveNoteIn };
