const assert = require("node:assert/strict");
const test = require("node:test");
const { showsMembersCount, workspacePlanState } = require("../../src/lib/workspacePlanState.ts");

const NOW = Date.parse("2026-11-20T12:00:00Z");
const PERIOD_END = "2026-12-20T00:00:00Z";
// The API keeps a deleted subscription's last period end, so an ended plan normally reads a past one.
const ENDED_AT = "2026-11-10T00:00:00Z";
const ROLE_KEY = (role) => `settingsPage.workspace.role.${role}`;
const SEAT_KEY = (seat) => `settingsPage.billing.workspace.details.${seat}`;

const workspace = (overrides = {}) => ({
  id: "ws-1",
  name: "Acme",
  slug: "acme",
  created_by_user_id: "owner",
  stripe_customer_id: "cus_1",
  stripe_subscription_id: "sub_1",
  plan: "business",
  status: "active",
  trial_ends_at: null,
  current_period_end: PERIOD_END,
  cancel_at_period_end: false,
  seats: 5,
  seats_used: 3,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  role: "owner",
  is_billable: true,
  billing_manager: "Dana Lee",
  has_subscription: true,
  is_default: false,
  is_account_default: false,
  ...overrides,
});
const people = (members, invitations) => ({
  members,
  invitations,
});
const free = (overrides = {}) =>
  workspace({
    plan: "free",
    stripe_subscription_id: null,
    has_subscription: false,
    current_period_end: null,
    seats: 0,
    seats_used: 0,
    ...overrides,
  });
const managerRow = (name, email) => ({
  labelKey: "details.managedBy",
  value: { kind: "manager", name, email },
});
const memberDetails = (role, seat, manager = managerRow("Dana Lee", null)) => ({
  titleKey: "workspaceDetails",
  rows: [
    { labelKey: "details.workspace", value: { kind: "text", text: "Acme" } },
    { labelKey: "details.yourRole", value: { kind: "key", key: ROLE_KEY(role) } },
    ...(seat
      ? [{ labelKey: "details.yourSeat", value: { kind: "key", key: SEAT_KEY(seat) } }]
      : []),
    ...(manager ? [manager] : []),
  ],
});
const periodEndsDetails = {
  titleKey: "billingDetails",
  rows: [{ labelKey: "details.periodEnds", value: { kind: "date", iso: PERIOD_END } }],
};

test("Business member: managed seat, unlimited use, workspace details", () => {
  const state = workspacePlanState(workspace({ role: "member" }), null, NOW);
  assert.deepEqual(state, {
    role: "member",
    tier: "business",
    badge: null,
    managedBadge: true,
    planLine: { key: "planLine.paidBy", params: { workspace: "Acme" } },
    billingInterval: null,
    seatPrice: null,
    planActions: [],
    freeCta: false,
    banner: null,
    usage: [{ kind: "unlimited" }],
    details: memberDetails("member", "paidSeat"),
    showPlansGrid: false,
  });
});

test("Business admin: managed seat, seats meter, no billing buttons", () => {
  const state = workspacePlanState(workspace({ role: "admin" }), people(3, 1), NOW);
  assert.equal(state.role, "admin");
  assert.equal(state.managedBadge, true);
  assert.equal(state.badge, null);
  assert.deepEqual(state.planLine, { key: "planLine.paidBy", params: { workspace: "Acme" } });
  assert.deepEqual(state.planActions, []);
  assert.equal(state.banner, null);
  assert.deepEqual(state.usage, [
    {
      kind: "seats",
      used: 3,
      total: 5,
      captionKey: "usage.pendingInvites",
      params: { count: "1" },
      addSeats: false,
    },
  ]);
  assert.deepEqual(state.details, memberDetails("admin", "paidSeat"));
});

test("Business owner (Stripe): Manage billing, Upgrade to Enterprise, Add seats, period end", () => {
  const state = workspacePlanState(workspace(), people(3, 0), NOW);
  assert.deepEqual(state, {
    role: "owner",
    tier: "business",
    badge: null,
    managedBadge: false,
    planLine: null,
    billingInterval: null,
    seatPrice: null,
    planActions: [{ kind: "manageBilling" }, { kind: "upgradeEnterprise" }],
    freeCta: false,
    banner: null,
    usage: [{ kind: "seats", used: 3, total: 5, captionKey: null, addSeats: true }],
    details: periodEndsDetails,
    showPlansGrid: false,
  });
});

test("Business owner on trial: days-left badge and first invoice date", () => {
  const trialEnds = "2026-11-25T00:00:00Z";
  const state = workspacePlanState(
    workspace({ status: "trialing", trial_ends_at: trialEnds, current_period_end: trialEnds }),
    people(2, 0),
    NOW
  );
  assert.deepEqual(state.badge, { key: "badges.trial", params: { days: "5" }, tone: "info" });
  assert.equal(state.banner, null);
  assert.deepEqual(state.details, {
    titleKey: "billingDetails",
    rows: [{ labelKey: "details.firstInvoice", value: { kind: "date", iso: trialEnds } }],
  });
});

test("trial days left never goes below zero, and a trial with no end date has no count", () => {
  const ended = workspacePlanState(
    workspace({ status: "trialing", trial_ends_at: "2026-11-01T00:00:00Z" }),
    null,
    NOW
  );
  assert.deepEqual(ended.badge, { key: "badges.trial", params: { days: "0" }, tone: "info" });
  const undated = workspacePlanState(
    workspace({ status: "trialing", trial_ends_at: null }),
    null,
    NOW
  );
  assert.deepEqual(undated.badge, { key: "badges.trialUndated", tone: "info" });
});

test("Business owner set to cancel: ends banner with Keep plan, ends date", () => {
  const state = workspacePlanState(workspace({ cancel_at_period_end: true }), people(3, 0), NOW);
  assert.deepEqual(state.banner, {
    tone: "warning",
    titleKey: "banners.ends.title",
    bodyKey: "banners.ends.body",
    params: { plan: "Business", date: PERIOD_END },
    action: { kind: "keepPlan" },
  });
  assert.deepEqual(state.details, {
    titleKey: "billingDetails",
    rows: [{ labelKey: "details.ends", value: { kind: "date", iso: PERIOD_END } }],
  });
  assert.deepEqual(state.planActions, [{ kind: "manageBilling" }, { kind: "upgradeEnterprise" }]);
});

test("past-due copy reflects the loss of workspace entitlement as soon as the payment fails", () => {
  const { workspace: copy } = require("../../src/locales/en/translation.json").settingsPage.billing;
  assert.ok(copy.banners.paymentFailed.body.includes("restore {{plan}}"));
  assert.match(copy.banners.memberPaymentProblem.body, /Your personal plan applies/);
});

test("Business owner past due: destructive badge, payment failed banner, no Add seats", () => {
  const state = workspacePlanState(workspace({ status: "past_due" }), people(3, 0), NOW);
  assert.deepEqual(state.badge, { key: "badges.pastDue", tone: "destructive" });
  assert.deepEqual(state.banner, {
    tone: "destructive",
    titleKey: "banners.paymentFailed.title",
    bodyKey: "banners.paymentFailed.body",
    params: { plan: "Business" },
    action: { kind: "updatePayment" },
  });
  assert.deepEqual(state.planActions, [{ kind: "manageBilling" }]);
  assert.equal(state.usage[0].addSeats, false);
  assert.deepEqual(state.details, periodEndsDetails);
});

test("Business owner unpaid: unpaid badge and paused banner with Update payment", () => {
  const state = workspacePlanState(workspace({ status: "unpaid" }), people(3, 0), NOW);
  assert.deepEqual(state.badge, { key: "badges.unpaid", tone: "destructive" });
  assert.deepEqual(state.banner, {
    tone: "destructive",
    titleKey: "banners.paused.title",
    bodyKey: "banners.paused.body",
    params: { plan: "Business" },
    action: { kind: "updatePayment" },
  });
});

test("Business owner incomplete: warning badge and Finish checkout", () => {
  const state = workspacePlanState(workspace({ status: "incomplete" }), people(1, 0), NOW);
  assert.deepEqual(state.badge, { key: "badges.incomplete", tone: "warning" });
  assert.deepEqual(state.banner, {
    tone: "warning",
    titleKey: "banners.checkoutIncomplete.title",
    bodyKey: "banners.checkoutIncomplete.body",
    params: { plan: "Business" },
    action: { kind: "finishCheckout" },
  });
});

test("Business owner cancelled: ended banner with Resubscribe and ended date", () => {
  const state = workspacePlanState(
    workspace({ status: "canceled", current_period_end: ENDED_AT }),
    people(3, 0),
    NOW
  );
  assert.deepEqual(state.badge, { key: "badges.cancelled", tone: "destructive" });
  assert.deepEqual(state.banner, {
    tone: "warning",
    titleKey: "banners.ended.title",
    bodyKey: "banners.ended.body",
    params: { plan: "Business", date: ENDED_AT },
    action: { kind: "resubscribe" },
  });
  assert.deepEqual(state.details, {
    titleKey: "billingDetails",
    rows: [{ labelKey: "details.ended", value: { kind: "date", iso: ENDED_AT } }],
  });
  assert.equal(state.usage[0].addSeats, false);
});

test("a plan cancelled before its period end never names a future date as its end", () => {
  // Cancelled at once (dashboard, failed retries): the API leaves the unreached period end.
  const state = workspacePlanState(workspace({ status: "canceled" }), people(3, 0), NOW);
  assert.deepEqual(state.banner, {
    tone: "warning",
    titleKey: "banners.endedUndated.title",
    bodyKey: "banners.endedUndated.body",
    params: { plan: "Business" },
    action: { kind: "resubscribe" },
  });
  assert.equal(state.details, null);
  // Ending exactly now counts as ended.
  const atNow = workspacePlanState(
    workspace({ status: "canceled", current_period_end: new Date(NOW).toISOString() }),
    null,
    NOW
  );
  assert.equal(atNow.banner.titleKey, "banners.ended.title");
  // An unparseable date names nothing.
  const garbled = workspacePlanState(
    workspace({ status: "canceled", current_period_end: "not-a-date" }),
    null,
    NOW
  );
  assert.equal(garbled.banner.titleKey, "banners.endedUndated.title");
  assert.equal(garbled.details, null);
});

test("a cancelled plan with no end date uses the undated banner", () => {
  const state = workspacePlanState(
    workspace({ status: "canceled", current_period_end: null }),
    null,
    NOW
  );
  assert.deepEqual(state.banner, {
    tone: "warning",
    titleKey: "banners.endedUndated.title",
    bodyKey: "banners.endedUndated.body",
    params: { plan: "Business" },
    action: { kind: "resubscribe" },
  });
  assert.equal(state.details, null);
});

test("Business owner with every seat used: no seats left caption, with pending invites", () => {
  const full = workspace({ seats: 3, seats_used: 3 });
  const noInvites = workspacePlanState(full, people(3, 0), NOW);
  assert.deepEqual(noInvites.usage, [
    { kind: "seats", used: 3, total: 3, captionKey: "usage.noSeatsLeft", addSeats: true },
  ]);
  const withInvites = workspacePlanState(full, people(3, 2), NOW);
  assert.deepEqual(withInvites.usage, [
    {
      kind: "seats",
      used: 3,
      total: 3,
      captionKey: "usage.noSeatsLeftWithInvites",
      params: { count: "2" },
      addSeats: true,
    },
  ]);
  const unknown = workspacePlanState(full, { members: "loading", invitations: "loading" }, NOW);
  assert.equal(unknown.usage[0].captionKey, "usage.noSeatsLeft");
});

test("a list without seats_used never says no seats are left", () => {
  const legacy = workspace({ seats: 3, seats_used: undefined });
  assert.equal(workspacePlanState(legacy, people(3, 0), NOW).usage[0].captionKey, null);
  assert.equal(
    workspacePlanState({ ...legacy, seats_used: null }, people(3, 0), NOW).usage[0].captionKey,
    null
  );
  // Pending invitations still say so.
  const invited = workspacePlanState(legacy, people(3, 2), NOW).usage[0];
  assert.equal(invited.captionKey, "usage.pendingInvites");
  assert.deepEqual(invited.params, { count: "2" });
});

test("seats used over the purchased count widen the meter; missing seats_used reads seats", () => {
  const over = workspacePlanState(workspace({ seats: 3, seats_used: 4 }), null, NOW);
  assert.equal(over.usage[0].used, 4);
  assert.equal(over.usage[0].total, 4);
  const legacy = workspacePlanState(workspace({ seats: 3, seats_used: undefined }), null, NOW);
  assert.equal(legacy.usage[0].used, 3);
  assert.equal(legacy.usage[0].total, 3);
});

test("Business owner billed without Stripe: invoiced by OpenWhispr, no Stripe buttons", () => {
  const state = workspacePlanState(
    workspace({ stripe_subscription_id: null, has_subscription: true }),
    people(3, 0),
    NOW
  );
  assert.deepEqual(state.planLine, { key: "planLine.invoicedByOpenWhispr" });
  assert.deepEqual(state.planActions, []);
  assert.equal(state.usage[0].addSeats, false);
  assert.deepEqual(state.details, {
    titleKey: "billingDetails",
    rows: [
      {
        labelKey: "details.billing",
        value: { kind: "key", key: "settingsPage.billing.workspace.details.invoicedByOpenWhispr" },
      },
    ],
  });
});

test("a provisioned owner never gets a Stripe payment button in a banner", () => {
  for (const status of ["past_due", "unpaid", "incomplete"]) {
    const state = workspacePlanState(
      workspace({ status, stripe_subscription_id: null, has_subscription: true }),
      null,
      NOW
    );
    assert.ok(state.banner, status);
    assert.equal(state.banner.action, undefined, status);
  }
  const ending = workspacePlanState(
    workspace({ cancel_at_period_end: true, stripe_subscription_id: null, has_subscription: true }),
    null,
    NOW
  );
  assert.equal(ending.banner.action, undefined);
});

test("Business admin past due: member payment problem banner, personal plan applies", () => {
  const state = workspacePlanState(
    workspace({ role: "admin", status: "past_due" }),
    people(3, 0),
    NOW
  );
  assert.equal(state.badge, null);
  assert.equal(state.managedBadge, false);
  assert.deepEqual(state.banner, {
    tone: "destructive",
    titleKey: "banners.memberPaymentProblem.title",
    bodyKey: "banners.memberPaymentProblem.body",
    params: { workspace: "Acme" },
  });
  assert.deepEqual(state.planLine, { key: "planLine.personalApplies" });
  assert.deepEqual(state.planActions, [{ kind: "viewPersonal" }]);
  assert.equal(state.usage[0].kind, "seats");
  assert.equal(state.usage[0].addSeats, false);
  assert.deepEqual(state.details, memberDetails("admin", null));
});

test("Business member past due: payment problem banner, pointed at the personal plan", () => {
  const state = workspacePlanState(workspace({ role: "member", status: "past_due" }), null, NOW);
  assert.equal(state.badge, null);
  assert.equal(state.managedBadge, false);
  assert.equal(state.banner.titleKey, "banners.memberPaymentProblem.title");
  assert.equal(state.banner.tone, "destructive");
  assert.equal(state.banner.action, undefined);
  assert.deepEqual(state.planLine, { key: "planLine.personalApplies" });
  assert.deepEqual(state.planActions, [{ kind: "viewPersonal" }]);
  assert.deepEqual(state.usage, []);
  // The plan lapsed, not the seat: there is no seat to speak of.
  assert.deepEqual(state.details, memberDetails("member", null));
});

test("Business member paused: paused badge and banner, personal plan applies", () => {
  for (const status of ["unpaid", "canceled"]) {
    const state = workspacePlanState(workspace({ role: "member", status }), null, NOW);
    assert.deepEqual(state.badge, { key: "badges.paused", tone: "warning" }, status);
    assert.deepEqual(
      state.banner,
      {
        tone: "warning",
        titleKey: "banners.memberPaused.title",
        bodyKey: "banners.memberPaused.body",
        params: { workspace: "Acme" },
      },
      status
    );
    assert.deepEqual(state.planLine, { key: "planLine.personalApplies" }, status);
    assert.deepEqual(state.planActions, [{ kind: "viewPersonal" }], status);
    assert.deepEqual(state.usage, [], status);
    assert.deepEqual(state.details, memberDetails("member", null), status);
  }
});

test("Business admin paused: paused badge, seats meter without Add seats", () => {
  const state = workspacePlanState(
    workspace({ role: "admin", status: "unpaid" }),
    people(3, 0),
    NOW
  );
  assert.deepEqual(state.badge, { key: "badges.paused", tone: "warning" });
  assert.equal(state.banner.titleKey, "banners.memberPaused.title");
  assert.deepEqual(state.planActions, [{ kind: "viewPersonal" }]);
  assert.equal(state.usage[0].kind, "seats");
  assert.equal(state.usage[0].addSeats, false);
});

test("Business member without a paid seat: personal plan applies, no usage", () => {
  const state = workspacePlanState(workspace({ role: "member", is_billable: false }), null, NOW);
  assert.equal(state.managedBadge, false);
  assert.deepEqual(state.planLine, { key: "planLine.personalApplies" });
  assert.deepEqual(state.planActions, [{ kind: "viewPersonal" }]);
  assert.equal(state.banner, null);
  assert.deepEqual(state.usage, []);
  assert.deepEqual(state.details, memberDetails("member", "noPaidSeat"));
});

test("Business admin without a paid seat: personal plan applies, seats meter", () => {
  const state = workspacePlanState(
    workspace({ role: "admin", is_billable: false }),
    people(3, 0),
    NOW
  );
  assert.equal(state.managedBadge, false);
  assert.deepEqual(state.planLine, { key: "planLine.personalApplies" });
  assert.deepEqual(state.planActions, [{ kind: "viewPersonal" }]);
  assert.equal(state.usage[0].kind, "seats");
  assert.deepEqual(state.details, memberDetails("admin", "noPaidSeat"));
});

test("Enterprise member: managed, unlimited, no console", () => {
  const state = workspacePlanState(workspace({ role: "member", plan: "enterprise" }), null, NOW);
  assert.equal(state.tier, "enterprise");
  assert.equal(state.managedBadge, true);
  assert.deepEqual(state.planActions, []);
  assert.deepEqual(state.usage, [{ kind: "unlimited" }]);
});

test("Enterprise admin: Open console", () => {
  const state = workspacePlanState(
    workspace({ role: "admin", plan: "enterprise" }),
    people(3, 0),
    NOW
  );
  assert.deepEqual(state.planActions, [{ kind: "openConsole" }]);
  assert.equal(state.managedBadge, true);
});

test("Enterprise owner: Manage billing and Open console, no upgrade", () => {
  const state = workspacePlanState(workspace({ plan: "enterprise" }), people(3, 0), NOW);
  assert.equal(state.tier, "enterprise");
  assert.deepEqual(state.planActions, [{ kind: "manageBilling" }, { kind: "openConsole" }]);
  assert.equal(state.usage[0].addSeats, true);
});

test("Enterprise owner past due: payment failed banner, no console while unentitled", () => {
  const state = workspacePlanState(
    workspace({ plan: "enterprise", status: "past_due" }),
    people(3, 0),
    NOW
  );
  assert.deepEqual(state.badge, { key: "badges.pastDue", tone: "destructive" });
  assert.deepEqual(state.banner.params, { plan: "Enterprise" });
  assert.deepEqual(state.banner.action, { kind: "updatePayment" });
  assert.deepEqual(state.planActions, [{ kind: "manageBilling" }]);
});

test("Enterprise owner cancelled: ended banner without Resubscribe", () => {
  const state = workspacePlanState(
    workspace({ plan: "enterprise", status: "canceled", current_period_end: ENDED_AT }),
    null,
    NOW
  );
  assert.equal(state.banner.titleKey, "banners.ended.title");
  assert.equal(state.banner.action, undefined);
});

test("a lapsed paid plan with no subscription left offers the Business and Enterprise grid in its own view", () => {
  for (const plan of ["business", "enterprise"]) {
    const state = workspacePlanState(
      workspace({
        plan,
        status: "canceled",
        stripe_subscription_id: null,
        has_subscription: false,
      }),
      people(3, 0),
      NOW
    );
    assert.equal(state.showPlansGrid, true, plan);
    assert.equal(state.freeCta, false, plan);
    assert.deepEqual(state.planActions, [{ kind: "upgradeEnterprise" }], plan);
  }
  // Only the owner who bills it can buy.
  const admin = workspacePlanState(
    workspace({
      role: "admin",
      status: "canceled",
      stripe_subscription_id: null,
      has_subscription: false,
    }),
    people(3, 0),
    NOW
  );
  assert.equal(
    admin.planActions.some((action) => action.kind === "upgradeEnterprise"),
    false
  );
});

test("free workspace owner: free buttons, members count, plans grid", () => {
  const state = workspacePlanState(free(), people(2, 1), NOW);
  assert.deepEqual(state, {
    role: "owner",
    tier: "free",
    badge: null,
    managedBadge: false,
    planLine: { key: "planLine.free" },
    billingInterval: null,
    seatPrice: null,
    planActions: [],
    freeCta: true,
    banner: null,
    usage: [{ kind: "members", count: 2 }],
    details: null,
    showPlansGrid: true,
  });
});

test("free workspace owner: members count unknown while it loads, then from the list", () => {
  assert.deepEqual(
    workspacePlanState(free(), { members: "loading", invitations: "loading" }, NOW).usage,
    [{ kind: "members", count: null }]
  );
  assert.deepEqual(workspacePlanState(free({ member_count: 4 }), null, NOW).usage, [
    { kind: "members", count: 4 },
  ]);
  assert.deepEqual(
    workspacePlanState(free({ member_count: 4 }), { members: "failed", invitations: null }, NOW)
      .usage,
    [{ kind: "members", count: 4 }]
  );
});

test("a members count that failed or was never read drops the row, never shows a dash", () => {
  for (const role of ["owner", "admin"]) {
    assert.deepEqual(
      workspacePlanState(free({ role }), { members: "failed", invitations: null }, NOW).usage,
      [],
      role
    );
    assert.deepEqual(workspacePlanState(free({ role }), null, NOW).usage, [], role);
  }
});

test("showsMembersCount: owners and admins of a free workspace", () => {
  assert.equal(showsMembersCount(free()), true);
  assert.equal(showsMembersCount(free({ role: "admin" })), true);
  assert.equal(showsMembersCount(free({ role: "member" })), false);
  assert.equal(showsMembersCount(workspace()), false);
  assert.equal(showsMembersCount(workspace({ role: "admin" })), false);
});

test("free workspace admin: personal plan applies, members count, no grid", () => {
  const state = workspacePlanState(free({ role: "admin" }), people(2, 0), NOW);
  assert.equal(state.freeCta, false);
  assert.equal(state.showPlansGrid, false);
  assert.deepEqual(state.planLine, { key: "planLine.personalApplies" });
  assert.deepEqual(state.planActions, [{ kind: "viewPersonal" }]);
  assert.deepEqual(state.usage, [{ kind: "members", count: 2 }]);
  assert.deepEqual(state.details, memberDetails("admin", null));
});

test("free workspace member: personal plan applies, no usage, workspace details", () => {
  const state = workspacePlanState(free({ role: "member" }), null, NOW);
  assert.equal(state.tier, "free");
  assert.equal(state.badge, null);
  assert.equal(state.managedBadge, false);
  assert.deepEqual(state.planLine, { key: "planLine.personalApplies" });
  assert.deepEqual(state.planActions, [{ kind: "viewPersonal" }]);
  assert.equal(state.banner, null);
  assert.deepEqual(state.usage, []);
  assert.deepEqual(state.details, memberDetails("member", null));
  assert.equal(state.showPlansGrid, false);
});

test("long workspace and manager names pass through untouched", () => {
  const longWorkspace = "The Extraordinarily Long Workspace Name For Testing Truncation Ltd.";
  const longManager = "Maximiliana Alexandrina Featherstonehaugh-Cholmondeley";
  const state = workspacePlanState(
    workspace({ role: "member", name: longWorkspace, billing_manager: longManager }),
    null,
    NOW
  );
  assert.deepEqual(state.planLine.params, { workspace: longWorkspace });
  assert.deepEqual(state.details.rows[0].value, { kind: "text", text: longWorkspace });
  assert.deepEqual(state.details.rows.at(-1), managerRow(longManager, null));
});

test("manager email: only the API's email field is copyable", () => {
  const withEmail = workspacePlanState(
    workspace({ role: "member", billing_manager_email: "dana@acme.com" }),
    null,
    NOW
  );
  assert.deepEqual(withEmail.details.rows.at(-1), managerRow("Dana Lee", "dana@acme.com"));
  const nameIsEmail = workspacePlanState(
    workspace({ role: "member", billing_manager: "dana@acme.com" }),
    null,
    NOW
  );
  assert.deepEqual(nameIsEmail.details.rows.at(-1), managerRow("dana@acme.com", null));
  const noManager = workspacePlanState(
    workspace({ role: "member", billing_manager: null }),
    null,
    NOW
  );
  assert.deepEqual(noManager.details, memberDetails("member", "paidSeat", null));
});

test("pending invitations fall back to the workspace's own count", () => {
  const state = workspacePlanState(workspace({ invitation_count: 2 }), null, NOW);
  assert.equal(state.usage[0].captionKey, "usage.pendingInvites");
  assert.deepEqual(state.usage[0].params, { count: "2" });
});

test("roles come from capabilities, not the raw role", () => {
  const billingAdmin = workspacePlanState(
    workspace({
      role: "admin",
      capabilities: { manage_billing: true, manage_members: true, manage_settings: true },
    }),
    null,
    NOW
  );
  assert.equal(billingAdmin.role, "owner");
  const restrictedOwner = workspacePlanState(
    workspace({
      role: "owner",
      capabilities: { manage_billing: false, manage_members: false, manage_settings: false },
    }),
    null,
    NOW
  );
  assert.equal(restrictedOwner.role, "member");
});

test("a workspace with no seats at all shows no seats caption", () => {
  const empty = workspace({ seats: 0, seats_used: 0 });
  assert.equal(workspacePlanState(empty, people(0, 0), NOW).usage[0].captionKey, null);
  assert.equal(workspacePlanState(empty, null, NOW).usage[0].captionKey, null);
  // Pending invitations still say so: that caption is about the invitations, not the seats.
  const invited = workspacePlanState(empty, people(0, 2), NOW).usage[0];
  assert.equal(invited.captionKey, "usage.pendingInvites");
  assert.deepEqual(invited.params, { count: "2" });
});

test("a trial set to cancel keeps its trial badge and says when it ends", () => {
  const state = workspacePlanState(
    workspace({
      status: "trialing",
      trial_ends_at: "2026-11-25T12:00:00Z",
      cancel_at_period_end: true,
    }),
    people(3, 0),
    NOW
  );
  assert.deepEqual(state.badge, { key: "badges.trial", params: { days: "5" }, tone: "info" });
  assert.deepEqual(state.banner, {
    tone: "warning",
    titleKey: "banners.ends.title",
    bodyKey: "banners.ends.body",
    params: { plan: "Business", date: PERIOD_END },
    action: { kind: "keepPlan" },
  });
  assert.deepEqual(state.details, {
    titleKey: "billingDetails",
    rows: [{ labelKey: "details.ends", value: { kind: "date", iso: PERIOD_END } }],
  });
});

test("Stripe paused reads as unpaid, for owners and members", () => {
  const owner = workspacePlanState(workspace({ status: "paused" }), people(3, 0), NOW);
  assert.deepEqual(owner.badge, { key: "badges.unpaid", tone: "destructive" });
  assert.deepEqual(owner.banner, {
    tone: "destructive",
    titleKey: "banners.paused.title",
    bodyKey: "banners.paused.body",
    params: { plan: "Business" },
    action: { kind: "updatePayment" },
  });
  assert.equal(owner.usage[0].addSeats, false);
  const member = workspacePlanState(workspace({ role: "member", status: "paused" }), null, NOW);
  assert.deepEqual(member.badge, { key: "badges.paused", tone: "warning" });
  assert.equal(member.banner.titleKey, "banners.memberPaused.title");
  assert.deepEqual(member.planLine, { key: "planLine.personalApplies" });
  assert.deepEqual(member.planActions, [{ kind: "viewPersonal" }]);
  assert.equal(member.managedBadge, false);
});

test("Stripe incomplete_expired reads as ended, for owners and members", () => {
  const owner = workspacePlanState(
    workspace({ status: "incomplete_expired", current_period_end: ENDED_AT }),
    null,
    NOW
  );
  assert.deepEqual(owner.badge, { key: "badges.cancelled", tone: "destructive" });
  assert.deepEqual(owner.banner, {
    tone: "warning",
    titleKey: "banners.ended.title",
    bodyKey: "banners.ended.body",
    params: { plan: "Business", date: ENDED_AT },
    action: { kind: "resubscribe" },
  });
  assert.deepEqual(owner.details, {
    titleKey: "billingDetails",
    rows: [{ labelKey: "details.ended", value: { kind: "date", iso: ENDED_AT } }],
  });
  const member = workspacePlanState(
    workspace({ role: "member", status: "incomplete_expired" }),
    null,
    NOW
  );
  assert.deepEqual(member.badge, { key: "badges.paused", tone: "warning" });
  assert.equal(member.banner.titleKey, "banners.memberPaused.title");
  assert.deepEqual(member.planActions, [{ kind: "viewPersonal" }]);
});

test("list counts override legacy counts independently, preserving zero", () => {
  const freeWithCount = free({ member_count: 0 });
  assert.deepEqual(workspacePlanState(freeWithCount, people(6, 2), NOW).usage, [
    { kind: "members", count: 0 },
  ]);
  const full = workspace({ seats: 7, seats_used: 7, member_count: 6, invitation_count: 3 });
  const usage = workspacePlanState(full, people(6, 1), NOW).usage[0];
  assert.equal(usage.captionKey, "usage.noSeatsLeftWithInvites");
  assert.deepEqual(usage.params, { count: "3" });
  assert.equal(
    workspacePlanState({ ...full, invitation_count: 0 }, people(6, 1), NOW).usage[0].captionKey,
    "usage.noSeatsLeft"
  );
});

const billingSummary = {
  interval: "annual",
  unit_amount: 24000,
  next_invoice: { date: PERIOD_END, amount: 72000, currency: "usd" },
  billing_email: "customer@example.test",
};

const invoiceCases = [
  ["active", false, "details.nextInvoice"],
  ["trialing", false, "details.firstInvoice"],
  ["active", true, "details.ends"],
  ["trialing", true, "details.ends"],
  ["past_due", true, "details.nextRetry"],
  ["unpaid", true, "details.amountDue"],
  ["paused", true, "details.amountDue"],
  ["incomplete", true, "details.amountDue"],
  ["canceled", true, "details.ended"],
];

for (const [status, cancel, labelKey] of invoiceCases) {
  test(`owner billing details: ${status}, cancel flag ${cancel}`, () => {
    const outstanding =
      status === "active" || status === "trialing"
        ? null
        : {
            amount_remaining: 1900,
            currency: "usd",
            next_payment_attempt: status === "past_due" ? PERIOD_END : null,
          };
    const plan = workspacePlanState(
      workspace({
        status,
        current_period_end: status === "canceled" ? ENDED_AT : PERIOD_END,
      }),
      null,
      NOW,
      { ...billingSummary, cancel_at_period_end: cancel, outstanding_invoice: outstanding }
    );
    const rows = plan.details.rows;
    assert.ok(rows.some((row) => row.labelKey === labelKey));
    assert.deepEqual(
      rows.filter((row) => row.labelKey === "details.finalInvoice"),
      cancel && status !== "canceled"
        ? [
            {
              labelKey: "details.finalInvoice",
              value: { kind: "invoice", ...billingSummary.next_invoice },
            },
          ]
        : []
    );
    assert.deepEqual(rows.at(-1), {
      labelKey: "details.billingContact",
      value: { kind: "text", text: "customer@example.test" },
    });
    if (outstanding) {
      assert.equal(
        rows.some(
          (row) => row.labelKey === "details.ends" || row.labelKey === "details.nextInvoice"
        ),
        false
      );
      assert.deepEqual(
        rows.find(
          (row) =>
            row.labelKey === (status === "past_due" ? "details.nextRetry" : "details.amountDue")
        ).value,
        {
          kind: "invoice",
          date: outstanding.next_payment_attempt,
          amount: 1900,
          currency: "usd",
        }
      );
    }
  });
}

test("a past-due workspace with no balance keeps its period end alongside its final invoice", () => {
  const summary = { ...billingSummary, cancel_at_period_end: true, outstanding_invoice: null };
  const plan = workspacePlanState(workspace({ status: "past_due" }), null, NOW, summary);
  assert.deepEqual(
    plan.details.rows.map((row) => row.labelKey),
    ["details.periodEnds", "details.finalInvoice", "details.billingContact"]
  );
});

test("the live cancellation flag supersedes a stale workspace list flag", () => {
  const ending = workspace({ cancel_at_period_end: true });
  const repurchased = workspacePlanState(ending, null, NOW, {
    ...billingSummary,
    cancel_at_period_end: false,
  });
  assert.equal(repurchased.banner, null);
  assert.equal(repurchased.details.rows[0].labelKey, "details.nextInvoice");
  assert.equal(
    workspacePlanState(ending, null, NOW, billingSummary).banner.action.kind,
    "keepPlan"
  );
});

test("Stripe summary interval and price stay with the billing owner", () => {
  const owner = workspacePlanState(workspace(), null, NOW, billingSummary);
  assert.deepEqual(owner.billingInterval, "annual");
  assert.deepEqual(owner.seatPrice, { amount: 2000, currency: "usd" });
  const undated = workspacePlanState(workspace(), null, NOW, {
    ...billingSummary,
    next_invoice: null,
  });
  assert.equal(undated.billingInterval, "annual");
  assert.equal(undated.seatPrice, null);
  const admin = workspacePlanState(workspace({ role: "admin" }), null, NOW, billingSummary);
  assert.equal(admin.billingInterval, null);
  assert.equal(admin.seatPrice, null);
  assert.deepEqual(admin.details, memberDetails("admin", "paidSeat"));
  assert.deepEqual(admin.planActions, []);
  const enterprise = workspacePlanState(
    workspace({ plan: "enterprise" }),
    null,
    NOW,
    billingSummary
  );
  assert.equal(enterprise.seatPrice, null);
  assert.equal(enterprise.details.rows[0].labelKey, "details.nextInvoice");
});
