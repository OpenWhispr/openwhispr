const assert = require("node:assert/strict");
const test = require("node:test");
const { countLiveInvitations, freeWorkspaceCta } = require("../../src/lib/workspacePeople.ts");

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

test("counts only live invitations", () => {
  const invitations = [
    invite(),
    invite({ accepted_at: "2026-11-01T00:00:00Z" }),
    invite({ revoked_at: "2026-11-01T00:00:00Z" }),
    invite({ expires_at: "2026-11-01T00:00:00Z" }),
  ];
  assert.equal(countLiveInvitations(invitations, NOW), 1);
});

test("freeWorkspaceCta: a known solo workspace leads with Invite", () => {
  assert.equal(freeWorkspaceCta(owner(), { members: 1, invitations: 0 }), "invite");
});

test("freeWorkspaceCta: two or more people lead with Upgrade", () => {
  assert.equal(freeWorkspaceCta(owner(), { members: 1, invitations: 1 }), "upgrade");
});

test("freeWorkspaceCta: either count alone can establish that the workspace has a team", () => {
  assert.equal(freeWorkspaceCta(owner({ member_count: 2 }), null), "upgrade");
  assert.equal(
    freeWorkspaceCta(owner({ invitation_count: 2 }), { members: "failed", invitations: null }),
    "upgrade"
  );
});

test("freeWorkspaceCta: an unknown count never picks a primary", () => {
  assert.equal(freeWorkspaceCta(owner(), null), "pending");
  assert.equal(
    freeWorkspaceCta(owner(), { members: "loading", invitations: "loading" }),
    "pending"
  );
  assert.equal(freeWorkspaceCta(owner(), { members: "failed", invitations: "loading" }), "unknown");
});

test("freeWorkspaceCta: none for a subscribed workspace or someone who can't bill", () => {
  const solo = { members: 1, invitations: 0 };
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

test("freeWorkspaceCta: list counts decide without legacy reads and include seat-free people", () => {
  assert.equal(
    freeWorkspaceCta(owner({ member_count: 2, invitation_count: 0, seats_used: 1 }), null),
    "upgrade"
  );
  assert.equal(freeWorkspaceCta(owner({ member_count: 1, invitation_count: 0 }), null), "invite");
});
