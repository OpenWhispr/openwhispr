const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canSelfServeEnterprise,
  hasActiveWorkspaceSubscription,
  isEnterpriseConsoleAvailable,
} = require("../../src/lib/workspaceBilling.ts");

const workspace = (overrides = {}) => ({
  plan: "free",
  status: "active",
  role: "owner",
  stripe_subscription_id: null,
  ...overrides,
});

test("hasActiveWorkspaceSubscription: paid plan and entitled status, nothing else", () => {
  for (const plan of ["pro", "business", "enterprise"]) {
    assert.equal(hasActiveWorkspaceSubscription(workspace({ plan, status: "active" })), true);
    assert.equal(hasActiveWorkspaceSubscription(workspace({ plan, status: "trialing" })), true);
    assert.equal(hasActiveWorkspaceSubscription(workspace({ plan, status: "past_due" })), false);
    assert.equal(hasActiveWorkspaceSubscription(workspace({ plan, status: "canceled" })), false);
  }
  assert.equal(
    hasActiveWorkspaceSubscription(workspace({ plan: "free", status: "active" })),
    false
  );
});

test("canSelfServeEnterprise: an owner's free workspace with no Stripe subscription", () => {
  assert.equal(canSelfServeEnterprise(workspace()), true);
  assert.equal(canSelfServeEnterprise(workspace({ role: "admin" })), false);
  assert.equal(canSelfServeEnterprise(workspace({ role: "member" })), false);
});

test("canSelfServeEnterprise: mirrors the API 409 — any live subscription blocks checkout", () => {
  // A subscription that is past_due is still live in Stripe.
  assert.equal(
    canSelfServeEnterprise(
      workspace({ plan: "business", status: "past_due", stripe_subscription_id: "sub_1" })
    ),
    false
  );
  // Manually provisioned plans (no Stripe subscription) must not be clobbered either.
  assert.equal(canSelfServeEnterprise(workspace({ plan: "enterprise", status: "active" })), false);
  assert.equal(canSelfServeEnterprise(workspace({ plan: "business", status: "trialing" })), false);
  // A lapsed manual plan is free to buy again.
  assert.equal(canSelfServeEnterprise(workspace({ plan: "business", status: "canceled" })), true);
});

test("isEnterpriseConsoleAvailable: entitled Enterprise plan for owners and admins only", () => {
  const enterprise = (overrides) => workspace({ plan: "enterprise", ...overrides });
  assert.equal(isEnterpriseConsoleAvailable(enterprise({ role: "owner" })), true);
  assert.equal(isEnterpriseConsoleAvailable(enterprise({ role: "admin" })), true);
  assert.equal(isEnterpriseConsoleAvailable(enterprise({ role: "member" })), false);
  assert.equal(isEnterpriseConsoleAvailable(enterprise({ status: "trialing" })), true);
  assert.equal(isEnterpriseConsoleAvailable(enterprise({ status: "past_due" })), false);
  assert.equal(isEnterpriseConsoleAvailable(enterprise({ status: "canceled" })), false);
  assert.equal(isEnterpriseConsoleAvailable(workspace({ plan: "business", role: "owner" })), false);
});
