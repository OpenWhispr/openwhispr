const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canSelfServeEnterprise,
  canUpgradeWorkspaceToEnterprise,
  enterpriseTileCta,
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

test("canUpgradeWorkspaceToEnterprise: an owner's live lower-plan subscription, nothing else", () => {
  const business = (overrides) =>
    workspace({ plan: "business", stripe_subscription_id: "sub_1", ...overrides });
  assert.equal(canUpgradeWorkspaceToEnterprise(business()), true);
  assert.equal(canUpgradeWorkspaceToEnterprise(business({ plan: "pro" })), true);
  assert.equal(canUpgradeWorkspaceToEnterprise(business({ status: "trialing" })), true);
  assert.equal(canUpgradeWorkspaceToEnterprise(business({ role: "admin" })), false);
  assert.equal(canUpgradeWorkspaceToEnterprise(business({ role: "member" })), false);
  assert.equal(canUpgradeWorkspaceToEnterprise(business({ plan: "enterprise" })), false);
  assert.equal(canUpgradeWorkspaceToEnterprise(business({ status: "past_due" })), false);
  assert.equal(canUpgradeWorkspaceToEnterprise(business({ status: "canceled" })), false);
  // Manually provisioned plans have no subscription to update.
  assert.equal(canUpgradeWorkspaceToEnterprise(business({ stripe_subscription_id: null })), false);
});

test("enterpriseTileCta: eligible owners get the dialog, first-timers get create, members get the owner", () => {
  const ws = (id, role, overrides = {}) => ({
    id,
    role,
    billing_manager: null,
    plan: "free",
    status: "active",
    stripe_subscription_id: null,
    ...overrides,
  });

  // Owner with a checkout-eligible (unsubscribed) workspace → dialog.
  assert.deepEqual(enterpriseTileCta([ws("a", "member"), ws("b", "owner")], null), {
    action: "openDialog",
  });
  // Owner with an upgradeable Business subscription → dialog.
  assert.deepEqual(
    enterpriseTileCta(
      [ws("a", "owner", { plan: "business", stripe_subscription_id: "sub_1" })],
      null
    ),
    { action: "openDialog" }
  );
  // Owner whose only workspace is already Enterprise → contact sales, and no
  // ask-owner hint (they are the owner).
  assert.deepEqual(
    enterpriseTileCta(
      [ws("a", "owner", { plan: "enterprise", stripe_subscription_id: "sub_1" })],
      null
    ),
    { action: "contactSales", ownerName: null }
  );
  assert.deepEqual(enterpriseTileCta([], null), { action: "createWorkspace" });
  assert.deepEqual(enterpriseTileCta([ws("a", "admin", { billing_manager: "Alice" })], null), {
    action: "contactSales",
    ownerName: "Alice",
  });
  // The active workspace's owner wins over the first one.
  assert.deepEqual(
    enterpriseTileCta(
      [
        ws("a", "member", { billing_manager: "Alice" }),
        ws("b", "admin", { billing_manager: "Bob" }),
      ],
      "b"
    ),
    { action: "contactSales", ownerName: "Bob" }
  );
  // Unknown active id falls back to the first workspace; a missing name stays null.
  assert.deepEqual(enterpriseTileCta([ws("a", "member")], "gone"), {
    action: "contactSales",
    ownerName: null,
  });
});
