const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSpaceMemberRows } = require("../../src/lib/spaceMemberRows.ts");

const person = (userId, name, overrides = {}) => ({
  user_id: userId,
  role: "member",
  joined_at: "2026-01-01T00:00:00Z",
  email: `${userId}@openronnie.com`,
  name,
  image: null,
  direct_role: "member",
  via_teams: [],
  ...overrides,
});

const invitation = (id, email, role = "member") => ({
  id,
  email,
  role,
  expires_at: "2026-02-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
});

const teamRef = (id, name, access) => ({ id, name, ...(access ? { access } : {}) });

const build = (overrides = {}) =>
  buildSpaceMemberRows({
    members: [],
    invitations: [],
    teams: [],
    teamCounts: new Map(),
    canManage: true,
    ...overrides,
  });

const ids = (rows) => rows.map((row) => row.id);

test("admins, invitations, groups, then everyone else", () => {
  const rows = build({
    members: [
      person("ronnie", "Ronnie", { role: "admin", direct_role: "admin" }),
      person("misa", "Misa"),
      person("ravi", "Ravi"),
    ],
    invitations: [invitation("inv-1", "clark@gmail.com")],
    teams: [teamRef("sales", "Sales", "member")],
    teamCounts: new Map([["sales", 5]]),
  });

  assert.deepEqual(
    rows.map((row) => row.kind),
    ["person", "invitation", "group", "person", "person"]
  );
  assert.deepEqual(ids(rows), [
    "person:ronnie",
    "invitation:inv-1",
    "group:sales",
    "person:misa",
    "person:ravi",
  ]);
});

test("the API's order is kept inside each part", () => {
  const rows = build({
    members: [
      person("zed", "Zed"),
      person("ada", "Ada", { role: "admin", direct_role: "admin" }),
      person("bob", "Bob"),
      person("cy", "Cy", { role: "admin", direct_role: "admin" }),
    ],
    invitations: [invitation("b", "b@x.com"), invitation("a", "a@x.com")],
    teams: [teamRef("two", "Two"), teamRef("one", "One")],
  });

  assert.deepEqual(ids(rows), [
    "person:ada",
    "person:cy",
    "invitation:b",
    "invitation:a",
    "group:two",
    "group:one",
    "person:zed",
    "person:bob",
  ]);
});

test("someone both direct and via a group is a direct row", () => {
  const [row] = build({
    members: [
      person("misa", "Misa", {
        direct_role: "member",
        via_teams: [{ team_id: "sales", name: "Sales", role: "member", access: "member" }],
      }),
    ],
  });

  assert.equal(row.kind, "person");
  assert.equal(row.editable, true);
});

test("a person with a direct role carries the groups that make them an admin", () => {
  const [row] = build({
    members: [
      person("misa", "Misa", {
        role: "admin",
        via_teams: [
          { team_id: "sales", name: "Sales", role: "admin", access: "admin" },
          { team_id: "design", name: "Design", role: "member", access: "admin" },
          { team_id: "ops", name: "Ops", role: "admin", access: "member" },
        ],
      }),
      person("ravi", "Ravi"),
    ],
  });

  assert.deepEqual(row.adminVia, ["Sales"], "a group admin through an admin-capped assignment");
  assert.deepEqual(build({ members: [person("ravi", "Ravi")] })[0].adminVia, []);
});

test("an inherited person has no menu and names the group", () => {
  const [row] = build({
    members: [
      person("misa", "Misa", {
        direct_role: null,
        via_teams: [{ team_id: "sales", name: "Sales", role: "member", access: "member" }],
      }),
    ],
  });

  assert.equal(row.kind, "inherited");
  assert.equal(row.groupName, "Sales");
  assert.equal(row.asAdmin, false);
  assert.ok(!("editable" in row), "an inherited row carries no menu flag");
});

test("an inherited admin says so, and several groups are listed together", () => {
  const [row] = build({
    members: [
      person("misa", "Misa", {
        role: "admin",
        direct_role: null,
        via_teams: [
          { team_id: "sales", name: "Sales", role: "admin", access: "admin" },
          { team_id: "design", name: "Design", role: "member", access: "member" },
        ],
      }),
    ],
    formatNames: (names) => names.join(" & "),
  });

  assert.equal(row.kind, "inherited");
  assert.equal(row.asAdmin, true);
  assert.equal(row.groupName, "Sales & Design");
});

test("an invitation has no menu", () => {
  const [row] = build({ invitations: [invitation("inv-1", "clark@gmail.com", "member")] });

  assert.equal(row.kind, "invitation");
  assert.equal(row.invitation.email, "clark@gmail.com");
  assert.ok(!("editable" in row));
});

test("a person with a direct role has a menu, only with canManage", () => {
  const members = [person("misa", "Misa")];

  assert.equal(build({ members, canManage: true })[0].editable, true);
  assert.equal(build({ members, canManage: false })[0].editable, false);
});

test("a group row carries its access and count, and a missing count reads as unknown", () => {
  const rows = build({
    teams: [teamRef("sales", "Sales", "member"), teamRef("design", "Design", "admin")],
    teamCounts: new Map([["sales", 5]]),
  });

  assert.deepEqual(rows[0].team, { id: "sales", name: "Sales", access: "member", memberCount: 5 });
  assert.deepEqual(rows[1].team, {
    id: "design",
    name: "Design",
    access: "admin",
    memberCount: null,
  });
});

test("a group assigned before the API sent access reads as admin, as it always has", () => {
  const [row] = build({ teams: [teamRef("legacy", "Legacy")] });

  assert.equal(row.team.access, "admin");
});
