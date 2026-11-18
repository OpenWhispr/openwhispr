const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canSelfServeEnterprise,
  businessDowngradeAction,
  canUpgradeWorkspaceToEnterprise,
  enterpriseManageAction,
  enterpriseTileCta,
  entitledWorkspacePlans,
  hasActiveWorkspaceSubscription,
  hasSharedDictionaryPlan,
  hasSubscription,
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

test("entitledWorkspacePlans: the paid plans of entitled workspaces only", () => {
  assert.deepEqual(
    [
      ...entitledWorkspacePlans([
        workspace({ plan: "enterprise" }),
        workspace({ plan: "enterprise", status: "trialing" }),
        workspace({ plan: "business", status: "canceled" }),
        workspace({ plan: "free" }),
      ]),
    ],
    ["enterprise"]
  );
  assert.equal(entitledWorkspacePlans([]).size, 0);
});

test("enterpriseManageAction: Stripe for a Stripe-billed owner, console for owners and admins, nothing for members", () => {
  const ent = (id, role, overrides = {}) =>
    workspace({ id, role, plan: "enterprise", status: "active", ...overrides });

  assert.deepEqual(
    enterpriseManageAction([ent("a", "owner", { stripe_subscription_id: "sub_1" })], null),
    {
      kind: "stripePortal",
      workspaceId: "a",
    }
  );
  // A provisioned plan has no Stripe portal: the owner manages it in the console.
  assert.deepEqual(enterpriseManageAction([ent("a", "owner")], null), { kind: "console" });
  assert.deepEqual(
    enterpriseManageAction([ent("a", "admin", { stripe_subscription_id: "sub_1" })], null),
    {
      kind: "console",
    }
  );
  assert.equal(enterpriseManageAction([ent("a", "member")], null), null);
  // A lapsed Enterprise plan or a Business plan has nothing to manage here.
  assert.equal(enterpriseManageAction([ent("a", "owner", { status: "canceled" })], null), null);
  assert.equal(enterpriseManageAction([workspace({ id: "a", plan: "business" })], null), null);
  // The active workspace decides first.
  assert.deepEqual(
    enterpriseManageAction(
      [ent("a", "owner", { stripe_subscription_id: "sub_1" }), ent("b", "admin")],
      "b"
    ),
    { kind: "console" }
  );
});

test("businessDowngradeAction: Stripe for a Stripe-billed Enterprise owner, sales for provisioned, nothing otherwise", () => {
  const ent = (id, role, overrides = {}) =>
    workspace({ id, role, plan: "enterprise", status: "active", ...overrides });

  assert.deepEqual(
    businessDowngradeAction(
      [ent("a", "owner"), ent("b", "owner", { stripe_subscription_id: "sub_1" })],
      "a"
    ),
    { kind: "contactSales" }
  );
  assert.deepEqual(businessDowngradeAction([ent("a", "owner")], null), { kind: "contactSales" });
  assert.equal(
    businessDowngradeAction([ent("a", "admin", { stripe_subscription_id: "sub_1" })], null),
    null
  );
  assert.equal(
    businessDowngradeAction(
      [workspace({ id: "a", plan: "business", stripe_subscription_id: "sub_1" })],
      null
    ),
    null
  );
  assert.equal(businessDowngradeAction([], null), null);
});

test("hasSharedDictionaryPlan: Business or Enterprise while entitled, nothing else", () => {
  for (const plan of ["business", "enterprise"]) {
    assert.equal(hasSharedDictionaryPlan({ plan, status: "active" }), true);
    assert.equal(hasSharedDictionaryPlan({ plan, status: "trialing" }), true);
    assert.equal(hasSharedDictionaryPlan({ plan, status: "past_due" }), false);
    assert.equal(hasSharedDictionaryPlan({ plan, status: "canceled" }), false);
  }
  for (const plan of ["free", "pro"]) {
    assert.equal(hasSharedDictionaryPlan({ plan, status: "active" }), false);
  }
  assert.equal(hasSharedDictionaryPlan(null), false);
  assert.equal(hasSharedDictionaryPlan(undefined), false);
});

test("hasSubscription falls back to the Stripe id", () => {
  assert.equal(hasSubscription({ has_subscription: true, stripe_subscription_id: null }), true);
  assert.equal(
    hasSubscription({ has_subscription: false, stripe_subscription_id: "sub_1" }),
    false
  );
  // Older APIs send no has_subscription.
  assert.equal(hasSubscription({ stripe_subscription_id: "sub_1" }), true);
  assert.equal(hasSubscription({ stripe_subscription_id: null }), false);
});

test("billing gates follow capabilities over the role", () => {
  const capabilities = (overrides = {}) => ({
    manage_members: true,
    manage_teams: true,
    create_spaces: true,
    manage_settings: true,
    manage_billing: false,
    delete_workspace: false,
    transfer_ownership: false,
    leave: true,
    ...overrides,
  });
  // An owner the server denies billing (Require SSO unmet) gets no checkout.
  const blockedOwner = workspace({
    role: "owner",
    capabilities: capabilities({ manage_settings: false }),
  });
  assert.equal(canSelfServeEnterprise(blockedOwner), false);
  assert.equal(
    isEnterpriseConsoleAvailable({ ...blockedOwner, plan: "enterprise", status: "active" }),
    false
  );
});

test("has_subscription drives the checkout gate", () => {
  // The API reports the checkout gate, so a flagged free workspace cannot check out.
  const flagged = workspace({ has_subscription: true });
  assert.equal(canSelfServeEnterprise(flagged), false);
});

test("an owner of a manually provisioned plan stays sales-led", () => {
  const manual = workspace({
    plan: "business",
    status: "active",
    stripe_subscription_id: null,
    has_subscription: true,
  });
  assert.equal(canSelfServeEnterprise(manual), false);
  assert.equal(canUpgradeWorkspaceToEnterprise(manual), false);
  assert.deepEqual(enterpriseTileCta([{ id: "a", ...manual }], null), {
    action: "contactSales",
    ownerName: null,
  });
});

test("businessDowngradeAction: active eligible billing workspace wins before billing method", () => {
  const provisioned = workspace({ id: "provisioned", plan: "enterprise" });
  const stripe = workspace({ id: "stripe", plan: "enterprise", stripe_subscription_id: "sub_1" });
  const workspaces = [provisioned, stripe];
  assert.deepEqual(businessDowngradeAction(workspaces, "provisioned"), { kind: "contactSales" });
  assert.deepEqual(businessDowngradeAction(workspaces, "stripe"), {
    kind: "stripePortal",
    workspaceId: "stripe",
  });
  for (const activeWorkspaceId of [null, "missing"]) {
    assert.deepEqual(businessDowngradeAction(workspaces, activeWorkspaceId), {
      kind: "contactSales",
    });
  }
});

test("businessDowngradeAction: skips ineligible active workspaces and respects billing capabilities", () => {
  const fallback = workspace({ id: "fallback", plan: "enterprise" });
  for (const overrides of [
    { status: "past_due" },
    { status: "canceled" },
    { plan: "business" },
    { role: "member" },
    { capabilities: { manage_billing: false } },
  ]) {
    const active = workspace({
      id: "active",
      plan: "enterprise",
      stripe_subscription_id: "sub_1",
      ...overrides,
    });
    assert.deepEqual(businessDowngradeAction([active, fallback], "active"), {
      kind: "contactSales",
    });
    assert.equal(businessDowngradeAction([active], "active"), null);
  }
  const delegated = workspace({
    id: "delegated",
    plan: "enterprise",
    role: "member",
    status: "trialing",
    capabilities: { manage_billing: true },
    stripe_subscription_id: "sub_delegated",
  });
  assert.deepEqual(businessDowngradeAction([fallback, delegated], "delegated"), {
    kind: "stripePortal",
    workspaceId: "delegated",
  });
});
