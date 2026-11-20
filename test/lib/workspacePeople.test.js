const assert = require("node:assert/strict");
const test = require("node:test");
const { countPeople, freeWorkspaceCta } = require("../../src/lib/workspacePeople.ts");

const NOW = Date.parse("2026-11-20T00:00:00Z");
const invite = (overrides = {}) => ({
  accepted_at: null,
  revoked_at: null,
  expires_at: "2026-12-01T00:00:00Z",
  ...overrides,
});
const owner = (overrides = {}) => ({
  plan: "free",
  status: "active",
  role: "owner",
  stripe_subscription_id: null,
  ...overrides,
});

test("countPeople counts every member and only live invitations", () => {
  const members = [{ user_id: "owner" }, { user_id: "seat-free-admin", is_billable: false }];
  const invitations = [
    invite(),
    invite({ accepted_at: "2026-11-01T00:00:00Z" }),
    invite({ revoked_at: "2026-11-01T00:00:00Z" }),
    invite({ expires_at: "2026-11-01T00:00:00Z" }),
  ];
  assert.equal(countPeople(members, invitations, NOW), 3);
});

test("freeWorkspaceCta: a known solo workspace leads with Invite", () => {
  assert.equal(freeWorkspaceCta(owner(), { status: "known", count: 1 }), "invite");
});

test("freeWorkspaceCta: two or more people lead with Upgrade", () => {
  assert.equal(freeWorkspaceCta(owner(), { status: "known", count: 2 }), "upgrade");
});

test("freeWorkspaceCta: an unknown count never picks a primary", () => {
  assert.equal(freeWorkspaceCta(owner(), null), "pending");
  assert.equal(freeWorkspaceCta(owner(), { status: "loading" }), "pending");
  assert.equal(freeWorkspaceCta(owner(), { status: "failed" }), "unknown");
});

test("freeWorkspaceCta: none for a subscribed workspace or someone who can't bill", () => {
  const solo = { status: "known", count: 1 };
  assert.equal(freeWorkspaceCta(owner({ stripe_subscription_id: "sub" }), solo), "none");
  assert.equal(freeWorkspaceCta(owner({ has_subscription: true }), solo), "none");
  assert.equal(freeWorkspaceCta(owner({ plan: "business", status: "active" }), solo), "none");
  assert.equal(freeWorkspaceCta(owner({ role: "member" }), solo), "none");
});

test("freeWorkspaceCta: a billing manager who can't manage members goes straight to Upgrade", () => {
  const billingOnly = owner({
    capabilities: { manage_billing: true, manage_members: false },
  });
  assert.equal(freeWorkspaceCta(billingOnly, null), "upgrade");
});
