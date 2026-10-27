const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TEAM_SUMMARY_SHOWN,
  filterMembers,
  rosterHasTeams,
  teamSummary,
  membersView,
  invitationStatus,
  invitationDaysLeft,
  orderInvitations,
} = require("../../src/lib/peopleRoster.ts");

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const DAY = 86_400_000;

const member = (userId, extra = {}) => ({
  user_id: userId,
  role: "member",
  joined_at: "2026-10-01T00:00:00.000Z",
  email: `${userId}@acme.test`,
  name: userId,
  image: null,
  ...extra,
});

const invitation = (id, expiresAt) => ({
  id,
  email: `${id}@acme.test`,
  workspace_role: "member",
  team_ids: [],
  invited_by_user_id: "admin",
  expires_at: expiresAt,
  created_at: "2026-10-20T00:00:00.000Z",
  accepted_at: null,
  revoked_at: null,
});

test("filter trims, ignores case and matches email", () => {
  const members = [
    { name: "Oliver", email: "rowan@acme.test" },
    { name: "Ada", email: "ada@acme.test" },
  ];
  assert.deepEqual(filterMembers(members, "  ROWAN "), [members[0]]);
});

test("team summary shows two names and counts the rest", () => {
  const teams = [0, 1, 2, 3].map((n) => ({ id: `t${n}`, name: `Team ${n}` }));
  assert.equal(TEAM_SUMMARY_SHOWN, 2);
  assert.deepEqual(teamSummary(teams), { shown: ["Team 0", "Team 1"], more: 2 });
  assert.deepEqual(teamSummary([]), { shown: [], more: 0 });
  assert.deepEqual(teamSummary(undefined), { shown: [], more: 0 });
});

test("team column hides when the API sends no teams", () => {
  assert.equal(rosterHasTeams([member("a"), member("b")]), false);
});

test("an empty team list still counts as teams sent", () => {
  assert.equal(rosterHasTeams([member("a"), member("b", { teams: [] })]), true);
});

test("no results waits for the roster", () => {
  assert.deepEqual(membersView({ loading: true, error: false, members: [], query: "zack" }), {
    kind: "loading",
  });
});

test("a failed load with nothing cached reads as failed", () => {
  assert.deepEqual(membersView({ loading: false, error: true, members: [], query: "" }), {
    kind: "failed",
  });
});

test("a failed refresh keeps showing the cached roster", () => {
  const members = [member("a")];
  assert.deepEqual(membersView({ loading: false, error: true, members, query: "" }), {
    kind: "rows",
    rows: members,
  });
});

test("no match reports the query", () => {
  assert.deepEqual(
    membersView({ loading: false, error: false, members: [member("a")], query: " zack " }),
    { kind: "noResults", query: "zack" }
  );
});

test("a blank query over an empty roster shows empty rows", () => {
  assert.deepEqual(membersView({ loading: false, error: false, members: [], query: "  " }), {
    kind: "rows",
    rows: [],
  });
});

test("invitation at its expiry instant is expired", () => {
  assert.equal(invitationStatus({ expires_at: new Date(NOW).toISOString() }, NOW), "expired");
  assert.equal(invitationStatus({ expires_at: new Date(NOW + 1).toISOString() }, NOW), "pending");
});

test("unparseable expiry reads as expired", () => {
  assert.equal(invitationStatus({ expires_at: "not a date" }, NOW), "expired");
});

test("days left rounds up", () => {
  assert.equal(invitationDaysLeft({ expires_at: new Date(NOW + 2.2 * DAY).toISOString() }, NOW), 3);
  assert.equal(invitationDaysLeft({ expires_at: new Date(NOW + 1 * DAY).toISOString() }, NOW), 1);
});

test("pending invitations come before expired, keeping the API order", () => {
  const past = new Date(NOW - DAY).toISOString();
  const future = new Date(NOW + DAY).toISOString();
  const ordered = orderInvitations(
    [
      invitation("e1", past),
      invitation("p1", future),
      invitation("e2", past),
      invitation("p2", future),
    ],
    NOW
  );
  assert.deepEqual(
    ordered.map((inv) => inv.id),
    ["p1", "p2", "e1", "e2"]
  );
});
