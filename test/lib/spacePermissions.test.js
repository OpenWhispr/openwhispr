const test = require("node:test");
const assert = require("node:assert/strict");
const { canManageSpace, canManageTeamRoster } = require("../../src/lib/spacePermissions.ts");

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
