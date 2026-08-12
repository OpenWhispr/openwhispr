const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canChangeSpaceNoteScope,
  canDeleteSpaceNote,
  canManageSpace,
  canManageTeamRoster,
  canManageWorkspace,
  canMoveBetweenSpaces,
  canMoveOrDeleteSpaceFolder,
  ownsNote,
} = require("../../src/lib/spacePermissions.ts");

test("canManageWorkspace: owners and admins can manage", () => {
  assert.equal(canManageWorkspace("owner"), true);
  assert.equal(canManageWorkspace("admin"), true);
  assert.equal(canManageWorkspace("member"), false);
  assert.equal(canManageWorkspace(null), false);
  assert.equal(canManageWorkspace(undefined), false);
});

test("canManageSpace: space admin or workspace owner/admin", () => {
  const space = (myRole) => ({ my_role: myRole });
  assert.equal(canManageSpace(space("admin"), null), true);
  assert.equal(canManageSpace(space("member"), "owner"), true);
  assert.equal(canManageSpace(space("member"), "admin"), true);
  assert.equal(canManageSpace(space("member"), "member"), false);
  assert.equal(canManageSpace(space(null), "member"), false);
  assert.equal(canManageSpace(space(null), null), false);
});

test("canManageTeamRoster: team admin or workspace owner/admin", () => {
  assert.equal(canManageTeamRoster("admin", null), true);
  assert.equal(canManageTeamRoster("admin", "member"), true);
  assert.equal(canManageTeamRoster("member", "owner"), true);
  assert.equal(canManageTeamRoster(null, "admin"), true);
  assert.equal(canManageTeamRoster("member", "member"), false);
  assert.equal(canManageTeamRoster(null, "member"), false);
  assert.equal(canManageTeamRoster(undefined, null), false);
});

const privateSpace = { kind: "private", workspace_id: null };
const teamSpace = (workspaceId) => ({ kind: "team", workspace_id: workspaceId });

test("canMoveBetweenSpaces: private content may go anywhere", () => {
  assert.equal(canMoveBetweenSpaces(privateSpace, teamSpace("a")), true);
  assert.equal(canMoveBetweenSpaces(privateSpace, { kind: "private", workspace_id: null }), true);
});

test("canMoveBetweenSpaces: team content stays within its workspace", () => {
  assert.equal(canMoveBetweenSpaces(teamSpace("a"), teamSpace("a")), true);
  assert.equal(canMoveBetweenSpaces(teamSpace("a"), teamSpace("b")), false);
  assert.equal(canMoveBetweenSpaces(teamSpace("a"), privateSpace), false);
});

test("canMoveBetweenSpaces: legacy team spaces without a workspace never match", () => {
  assert.equal(canMoveBetweenSpaces(teamSpace(null), teamSpace(null)), false);
  assert.equal(canMoveBetweenSpaces(teamSpace(null), teamSpace("a")), false);
  assert.equal(canMoveBetweenSpaces(teamSpace("a"), teamSpace(null)), false);
});

// --- Note/folder destructive-action permissions (server rule mirror) ---

const ME = "user-me";
const TEAMMATE = "user-teammate";

const myNote = { cloud_id: "cloud-1", owner_user_id: ME };
const teammateNote = { cloud_id: "cloud-2", owner_user_id: TEAMMATE };
const unknownOwnerNote = { cloud_id: "cloud-3", owner_user_id: null };
const unsyncedNote = { cloud_id: null, owner_user_id: null };

const enforcedSpace = (myRole) => ({ kind: "team", cloud_space_id: "space-1", my_role: myRole });
const localOnlySpace = { kind: "team", cloud_space_id: null, my_role: null };
const personalSpace = { kind: "private", cloud_space_id: null, my_role: null };

test("ownsNote: unsynced rows belong to the current user; cloud rows fail closed", () => {
  assert.equal(ownsNote(unsyncedNote, ME), true);
  assert.equal(ownsNote(unsyncedNote, null), true);
  assert.equal(ownsNote(myNote, ME), true);
  assert.equal(ownsNote(teammateNote, ME), false);
  assert.equal(ownsNote(unknownOwnerNote, ME), false);
  assert.equal(ownsNote(myNote, null), false);
});

test("canDeleteSpaceNote: owner who is a plain member may delete their own note", () => {
  assert.equal(canDeleteSpaceNote(myNote, enforcedSpace("member"), ME, "member"), true);
});

test("canDeleteSpaceNote: plain member may not delete a teammate's note", () => {
  assert.equal(canDeleteSpaceNote(teammateNote, enforcedSpace("member"), ME, "member"), false);
  assert.equal(canDeleteSpaceNote(teammateNote, enforcedSpace(null), ME, null), false);
});

test("canDeleteSpaceNote: space admin (workspace member) may delete teammate notes", () => {
  assert.equal(canDeleteSpaceNote(teammateNote, enforcedSpace("admin"), ME, "member"), true);
});

test("canDeleteSpaceNote: workspace owner/admin may delete any note", () => {
  assert.equal(canDeleteSpaceNote(teammateNote, enforcedSpace("member"), ME, "admin"), true);
  assert.equal(canDeleteSpaceNote(teammateNote, enforcedSpace("member"), ME, "owner"), true);
});

test("canDeleteSpaceNote: unknown owner fails closed for plain members", () => {
  assert.equal(canDeleteSpaceNote(unknownOwnerNote, enforcedSpace("member"), ME, "member"), false);
  assert.equal(canDeleteSpaceNote(unknownOwnerNote, enforcedSpace("admin"), ME, "member"), true);
  assert.equal(canDeleteSpaceNote(unknownOwnerNote, enforcedSpace("member"), ME, "owner"), true);
});

test("canDeleteSpaceNote: private and local-only content stays manageable", () => {
  assert.equal(canDeleteSpaceNote(teammateNote, personalSpace, ME, null), true);
  assert.equal(canDeleteSpaceNote(teammateNote, localOnlySpace, ME, null), true);
  assert.equal(canDeleteSpaceNote(unsyncedNote, enforcedSpace("member"), ME, "member"), true);
  assert.equal(canDeleteSpaceNote(teammateNote, undefined, ME, null), true);
});

test("canChangeSpaceNoteScope: owner who is a plain member may change scope", () => {
  assert.equal(canChangeSpaceNoteScope(myNote, enforcedSpace("member"), ME, "member"), true);
});

test("canChangeSpaceNoteScope: space admin (workspace member) may NOT change a teammate note's scope", () => {
  assert.equal(canChangeSpaceNoteScope(teammateNote, enforcedSpace("admin"), ME, "member"), false);
});

test("canChangeSpaceNoteScope: workspace owner/admin may change any note's scope", () => {
  assert.equal(canChangeSpaceNoteScope(teammateNote, enforcedSpace("member"), ME, "admin"), true);
  assert.equal(canChangeSpaceNoteScope(teammateNote, enforcedSpace("member"), ME, "owner"), true);
});

test("canChangeSpaceNoteScope: plain member and unknown owner fail closed", () => {
  assert.equal(canChangeSpaceNoteScope(teammateNote, enforcedSpace("member"), ME, "member"), false);
  assert.equal(
    canChangeSpaceNoteScope(unknownOwnerNote, enforcedSpace("member"), ME, "member"),
    false
  );
});

test("canChangeSpaceNoteScope: private and unsynced notes stay manageable", () => {
  assert.equal(canChangeSpaceNoteScope(teammateNote, personalSpace, ME, null), true);
  assert.equal(canChangeSpaceNoteScope(unsyncedNote, enforcedSpace("member"), ME, "member"), true);
});

test("canMoveOrDeleteSpaceFolder: space admin or workspace owner/admin only", () => {
  assert.equal(canMoveOrDeleteSpaceFolder(enforcedSpace("admin"), "member"), true);
  assert.equal(canMoveOrDeleteSpaceFolder(enforcedSpace("member"), "admin"), true);
  assert.equal(canMoveOrDeleteSpaceFolder(enforcedSpace("member"), "owner"), true);
  assert.equal(canMoveOrDeleteSpaceFolder(enforcedSpace("member"), "member"), false);
  assert.equal(canMoveOrDeleteSpaceFolder(enforcedSpace(null), null), false);
});

test("canMoveOrDeleteSpaceFolder: private and local-only spaces stay manageable", () => {
  assert.equal(canMoveOrDeleteSpaceFolder(personalSpace, null), true);
  assert.equal(canMoveOrDeleteSpaceFolder(localOnlySpace, null), true);
  assert.equal(canMoveOrDeleteSpaceFolder(undefined, null), true);
});
