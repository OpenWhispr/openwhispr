const test = require("node:test");
const assert = require("node:assert/strict");
const { spaceCan, workspaceCan } = require("../../src/lib/capabilities.ts");

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

function allowed(workspace) {
  return WORKSPACE_CAPABILITIES.filter((capability) => workspaceCan(workspace, capability));
}

test("server capabilities win over the role", () => {
  const capabilities = Object.fromEntries(WORKSPACE_CAPABILITIES.map((name) => [name, false]));
  assert.equal(
    workspaceCan(
      { role: "member", capabilities: { ...capabilities, manage_members: true } },
      "manage_members"
    ),
    true
  );
  assert.equal(workspaceCan({ role: "owner", capabilities }, "manage_billing"), false);
  assert.equal(
    spaceCan(
      {
        my_role: "member",
        my_direct_role: null,
        teams: [],
        capabilities: {
          edit_notes: false,
          manage_members: true,
          manage_settings: false,
          leave: false,
        },
      },
      "manage_members"
    ),
    true
  );
  assert.equal(
    spaceCan(
      {
        my_role: "admin",
        my_direct_role: "admin",
        teams: [],
        capabilities: {
          edit_notes: true,
          manage_members: false,
          manage_settings: false,
          leave: false,
        },
      },
      "leave"
    ),
    false
  );
});

test("owner fallback matches the API table", () => {
  assert.deepEqual(
    allowed({ role: "owner" }),
    WORKSPACE_CAPABILITIES.filter((name) => name !== "leave")
  );
});

test("admin fallback cannot manage billing, delete or transfer, and can leave", () => {
  assert.deepEqual(allowed({ role: "admin" }), [
    "manage_members",
    "manage_teams",
    "create_spaces",
    "manage_settings",
    "leave",
  ]);
});

test("member fallback can only leave", () => {
  assert.deepEqual(allowed({ role: "member" }), ["leave"]);
});

test("space fallback: admin manages, member edits only", () => {
  const space = (myRole) => ({ my_role: myRole, my_direct_role: null, teams: [] });
  assert.equal(spaceCan(space("admin"), "edit_notes"), true);
  assert.equal(spaceCan(space("admin"), "manage_members"), true);
  assert.equal(spaceCan(space("admin"), "manage_settings"), true);
  assert.equal(spaceCan(space("member"), "edit_notes"), true);
  assert.equal(spaceCan(space("member"), "manage_members"), false);
  assert.equal(spaceCan(space("member"), "manage_settings"), false);
  assert.equal(spaceCan(space(null), "manage_settings"), false);
});

test("space leave fallback needs a direct role or a joined team", () => {
  const space = (myDirectRole, teams) => ({
    my_role: "member",
    my_direct_role: myDirectRole,
    teams,
  });
  assert.equal(spaceCan(space(null, []), "leave"), false);
  assert.equal(spaceCan(space(undefined, []), "leave"), false);
  assert.equal(spaceCan(space(null, [{ id: "t1", name: "A", my_role: null }]), "leave"), false);
  assert.equal(spaceCan(space(null, [{ id: "t1", name: "A", my_role: "member" }]), "leave"), true);
  assert.equal(spaceCan(space("member", []), "leave"), true);
});

test("null workspace or space can do nothing", () => {
  assert.equal(workspaceCan(null, "leave"), false);
  assert.equal(workspaceCan(undefined, "manage_members"), false);
  assert.equal(spaceCan(null, "edit_notes"), false);
  assert.equal(spaceCan(undefined, "leave"), false);
});

const { teamCan, teamCreationFor } = require("../../src/lib/capabilities.ts");

const noCapabilities = () =>
  Object.fromEntries(WORKSPACE_CAPABILITIES.map((name) => [name, false]));

test("an admin on Business is allowed to create teams", () => {
  const capabilities = { ...noCapabilities(), manage_teams: true, create_teams: true };
  assert.equal(teamCreationFor({ role: "admin", capabilities }), "allowed");
});

test("an admin below it gets the paywall", () => {
  const capabilities = { ...noCapabilities(), manage_teams: true, create_teams: false };
  assert.equal(teamCreationFor({ role: "admin", capabilities }), "paywall");
});

test("a member is unavailable", () => {
  const capabilities = { ...noCapabilities(), create_teams: false };
  assert.equal(teamCreationFor({ role: "member", capabilities }), "unavailable");
  assert.equal(teamCreationFor(null), "unavailable");
});

test("a missing create_teams lets the server answer", () => {
  const capabilities = { ...noCapabilities(), manage_teams: true };
  assert.equal(teamCreationFor({ role: "admin", capabilities }), "allowed");
});

test("a role-only cached row of an admin is allowed", () => {
  assert.equal(teamCreationFor({ role: "admin" }), "allowed");
  assert.equal(teamCreationFor({ role: "member" }), "unavailable");
});

test("team capabilities win over the workspace", () => {
  const workspace = { role: "admin" };
  const team = { capabilities: { manage_members: false, manage_settings: false, leave: true } };
  assert.equal(teamCan(team, workspace, "manage_members"), false);
  assert.equal(teamCan(team, workspace, "manage_settings"), false);
  assert.equal(teamCan(team, workspace, "leave"), true);
  const open = { capabilities: { manage_members: true, manage_settings: true, leave: false } };
  assert.equal(teamCan(open, { role: "member" }, "manage_members"), true);
});

test("an older API falls back to manage_teams, and never to leave", () => {
  assert.equal(teamCan({}, { role: "admin" }, "manage_members"), true);
  assert.equal(teamCan({}, { role: "admin" }, "manage_settings"), true);
  assert.equal(teamCan({}, { role: "member" }, "manage_members"), false);
  assert.equal(teamCan({}, { role: "admin" }, "leave"), false);
  assert.equal(teamCan({}, null, "manage_members"), false);
});
