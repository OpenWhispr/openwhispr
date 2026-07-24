const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canManageSpace,
  canManageTeamRoster,
  canMoveBetweenSpaces,
} = require("../../src/lib/spacePermissions.ts");

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
