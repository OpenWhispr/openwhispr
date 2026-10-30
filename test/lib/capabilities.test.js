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
