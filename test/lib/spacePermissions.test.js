const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canChangeSpaceNoteScope,
  canDeleteSpaceNote,
  canManageTeamRoster,
  canMoveBetweenSpaces,
  canMoveOrDeleteSpaceFolder,
  ownsNote,
} = require("../../src/lib/spacePermissions.ts");

const WORKSPACE_CAPABILITIES = [
  "manage_members",
  "manage_teams",
  "create_spaces",
  "manage_settings",
  "manage_billing",
  "delete_workspace",
  "transfer_ownership",
  "leave",
];

// A workspace as the store holds it: the role, and the server's capabilities
// when the API sent them (undefined reads through the role fallback).
const ws = (role, capabilities) => ({ role, capabilities });
// Server capabilities with only the named ones granted.
const granting = (...names) =>
  Object.fromEntries(WORKSPACE_CAPABILITIES.map((name) => [name, names.includes(name)]));

test("canManageTeamRoster: team admin or workspace owner/admin", () => {
  assert.equal(canManageTeamRoster("admin", null), true);
  assert.equal(canManageTeamRoster("admin", ws("member")), true);
  assert.equal(canManageTeamRoster("member", ws("owner")), true);
  assert.equal(canManageTeamRoster(null, ws("admin")), true);
  assert.equal(canManageTeamRoster("member", ws("member")), false);
  assert.equal(canManageTeamRoster(null, ws("member")), false);
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

const enforcedSpace = (myRole, capabilities) => ({
  kind: "team",
  cloud_space_id: "space-1",
  my_role: myRole,
  my_direct_role: null,
  teams: [],
  capabilities,
});
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
  assert.equal(canDeleteSpaceNote(myNote, enforcedSpace("member"), ME, ws("member")), true);
});

test("canDeleteSpaceNote: plain member may not delete a teammate's note", () => {
  assert.equal(canDeleteSpaceNote(teammateNote, enforcedSpace("member"), ME, ws("member")), false);
  assert.equal(canDeleteSpaceNote(teammateNote, enforcedSpace(null), ME, null), false);
});

test("canDeleteSpaceNote: space admin (workspace member) may delete teammate notes", () => {
  assert.equal(canDeleteSpaceNote(teammateNote, enforcedSpace("admin"), ME, ws("member")), true);
});

test("canDeleteSpaceNote: workspace owner/admin may delete any note", () => {
  assert.equal(canDeleteSpaceNote(teammateNote, enforcedSpace("member"), ME, ws("admin")), true);
  assert.equal(canDeleteSpaceNote(teammateNote, enforcedSpace("member"), ME, ws("owner")), true);
});

test("canDeleteSpaceNote: unknown owner fails closed for plain members", () => {
  assert.equal(
    canDeleteSpaceNote(unknownOwnerNote, enforcedSpace("member"), ME, ws("member")),
    false
  );
  assert.equal(
    canDeleteSpaceNote(unknownOwnerNote, enforcedSpace("admin"), ME, ws("member")),
    true
  );
  assert.equal(
    canDeleteSpaceNote(unknownOwnerNote, enforcedSpace("member"), ME, ws("owner")),
    true
  );
});

test("canDeleteSpaceNote: private and local-only content stays manageable", () => {
  assert.equal(canDeleteSpaceNote(teammateNote, personalSpace, ME, null), true);
  assert.equal(canDeleteSpaceNote(teammateNote, localOnlySpace, ME, null), true);
  assert.equal(canDeleteSpaceNote(unsyncedNote, enforcedSpace("member"), ME, ws("member")), true);
  assert.equal(canDeleteSpaceNote(teammateNote, undefined, ME, null), true);
});

test("canChangeSpaceNoteScope: owner who is a plain member may change scope", () => {
  assert.equal(canChangeSpaceNoteScope(myNote, enforcedSpace("member"), ME, ws("member")), true);
});

test("canChangeSpaceNoteScope: space admin (workspace member) may NOT change a teammate note's scope", () => {
  assert.equal(
    canChangeSpaceNoteScope(teammateNote, enforcedSpace("admin"), ME, ws("member")),
    false
  );
});

test("canChangeSpaceNoteScope: workspace owner/admin may change any note's scope", () => {
  assert.equal(
    canChangeSpaceNoteScope(teammateNote, enforcedSpace("member"), ME, ws("admin")),
    true
  );
  assert.equal(
    canChangeSpaceNoteScope(teammateNote, enforcedSpace("member"), ME, ws("owner")),
    true
  );
});

test("canChangeSpaceNoteScope: plain member and unknown owner fail closed", () => {
  assert.equal(
    canChangeSpaceNoteScope(teammateNote, enforcedSpace("member"), ME, ws("member")),
    false
  );
  assert.equal(
    canChangeSpaceNoteScope(unknownOwnerNote, enforcedSpace("member"), ME, ws("member")),
    false
  );
});

test("canChangeSpaceNoteScope: private and unsynced notes stay manageable", () => {
  assert.equal(canChangeSpaceNoteScope(teammateNote, personalSpace, ME, null), true);
  assert.equal(
    canChangeSpaceNoteScope(unsyncedNote, enforcedSpace("member"), ME, ws("member")),
    true
  );
});

test("canMoveOrDeleteSpaceFolder: space admin or workspace owner/admin only", () => {
  assert.equal(canMoveOrDeleteSpaceFolder(enforcedSpace("admin"), ws("member")), true);
  assert.equal(canMoveOrDeleteSpaceFolder(enforcedSpace("member"), ws("admin")), true);
  assert.equal(canMoveOrDeleteSpaceFolder(enforcedSpace("member"), ws("owner")), true);
  assert.equal(canMoveOrDeleteSpaceFolder(enforcedSpace("member"), ws("member")), false);
  assert.equal(canMoveOrDeleteSpaceFolder(enforcedSpace(null), null), false);
});

test("canMoveOrDeleteSpaceFolder: private and local-only spaces stay manageable", () => {
  assert.equal(canMoveOrDeleteSpaceFolder(personalSpace, null), true);
  assert.equal(canMoveOrDeleteSpaceFolder(localOnlySpace, null), true);
  assert.equal(canMoveOrDeleteSpaceFolder(undefined, null), true);
});

test("teamsUserCanLeave: only teams the user explicitly belongs to", () => {
  const { teamsUserCanLeave } = require("../../src/lib/spacePermissions.ts");
  const teams = [
    { id: "t1", name: "Sales", my_role: "member" },
    { id: "t2", name: "Leads", my_role: "admin" },
    { id: "t3", name: "Ops", my_role: null },
    { id: "t4", name: "Legacy" },
  ];
  assert.deepEqual(
    teamsUserCanLeave({ teams }).map((team) => team.id),
    ["t1", "t2"]
  );
  assert.deepEqual(teamsUserCanLeave({ teams: [] }), []);
});

test("capabilities override the role in content rules", () => {
  // An admin whose session doesn't satisfy Require SSO gets no admin powers.
  const ssoBlockedAdmin = ws("admin", granting("leave"));
  assert.equal(
    canDeleteSpaceNote(teammateNote, enforcedSpace("member"), ME, ssoBlockedAdmin),
    false
  );
  assert.equal(
    canChangeSpaceNoteScope(teammateNote, enforcedSpace("member"), ME, ssoBlockedAdmin),
    false
  );
  assert.equal(canMoveOrDeleteSpaceFolder(enforcedSpace("member"), ssoBlockedAdmin), false);
  assert.equal(canManageTeamRoster("member", ssoBlockedAdmin), false);

  // A member the server lets manage the workspace gets the admin rules.
  const grantedMember = ws("member", granting("manage_settings", "manage_teams"));
  assert.equal(canDeleteSpaceNote(teammateNote, enforcedSpace("member"), ME, grantedMember), true);
  assert.equal(
    canChangeSpaceNoteScope(teammateNote, enforcedSpace("member"), ME, grantedMember),
    true
  );
  assert.equal(canMoveOrDeleteSpaceFolder(enforcedSpace("member"), grantedMember), true);
  assert.equal(canManageTeamRoster(null, grantedMember), true);

  // Space capabilities decide "space admin" the same way.
  const spaceCapabilities = (manageSettings) => ({
    edit_notes: true,
    manage_members: manageSettings,
    manage_settings: manageSettings,
    leave: false,
  });
  assert.equal(
    canDeleteSpaceNote(
      teammateNote,
      enforcedSpace("admin", spaceCapabilities(false)),
      ME,
      ws("member")
    ),
    false
  );
  assert.equal(
    canDeleteSpaceNote(
      teammateNote,
      enforcedSpace("member", spaceCapabilities(true)),
      ME,
      ws("member")
    ),
    true
  );
  assert.equal(
    canMoveOrDeleteSpaceFolder(enforcedSpace("admin", spaceCapabilities(false)), ws("member")),
    false
  );
  assert.equal(
    canMoveOrDeleteSpaceFolder(enforcedSpace("member", spaceCapabilities(true)), ws("member")),
    true
  );
});
