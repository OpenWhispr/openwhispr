const test = require("node:test");
const assert = require("node:assert/strict");

const {
  decideUpsell,
  decideProPlanCardCta,
  resolveAccountPlan,
  storeSubscriptionsUrl,
} = require("../../src/lib/upsell.ts");

test("the upgrade CTA survives sign-out and is withheld while entitlement is unknown", () => {
  const decide = (overrides) =>
    decideUpsell({
      authLoaded: true,
      isSignedIn: true,
      hasPaidAccess: false,
      isPastDue: false,
      ...overrides,
    });

  assert.equal(decide({ isSignedIn: false }), "show");
  assert.equal(decide({ authLoaded: false, isSignedIn: false }), "unknown");
  assert.equal(decide({ hasPaidAccess: null }), "unknown");
  assert.equal(decide({ hasPaidAccess: true }), "hide");
  assert.equal(decide({ isPastDue: true }), "hide");
  assert.equal(decide({}), "show");
});

test("a workspace-covered member is never offered a personal Pro checkout", () => {
  const decide = (o) =>
    decideProPlanCardCta({
      isSignedIn: true,
      planStateKnown: true,
      isPersonallySubscribed: false,
      isStoreBilled: false,
      plan: "free",
      isTrial: false,
      isWorkspaceCovered: false,
      ...o,
    });
  // THE regression (customer bought Business + a 2-seat workspace 66s apart):
  assert.equal(decide({ isWorkspaceCovered: true }), "coveredByWorkspace");
  // coverage lapse mid-session: refreshed usage drops the workspace ids
  assert.equal(decide({}), "checkout");
});

test("a personal subscription keeps its manage and switch paths (double-payer)", () => {
  // personally subscribed pro — even if a workspace also covers them
  assert.equal(
    decideProPlanCardCta({
      isSignedIn: true,
      planStateKnown: true,
      isPersonallySubscribed: true,
      isStoreBilled: false,
      plan: "pro",
      isTrial: false,
      isWorkspaceCovered: false,
    }),
    "currentPlan"
  );
  // personally subscribed business keeps the downgrade-to-pro switch
  assert.equal(
    decideProPlanCardCta({
      isSignedIn: true,
      planStateKnown: true,
      isPersonallySubscribed: true,
      isStoreBilled: false,
      plan: "business",
      isTrial: false,
      isWorkspaceCovered: false,
    }),
    "downgradeToPro"
  );
});

test("no checkout renders while the entitlement is unknown", () => {
  assert.equal(
    decideProPlanCardCta({
      isSignedIn: true,
      planStateKnown: false,
      isPersonallySubscribed: false,
      isStoreBilled: false,
      plan: "free",
      isTrial: false,
      isWorkspaceCovered: false,
    }),
    "none"
  );
});

test("trial reads as the current plan, not an upsell target", () => {
  assert.equal(
    decideProPlanCardCta({
      isSignedIn: true,
      planStateKnown: true,
      isPersonallySubscribed: false,
      isStoreBilled: false,
      plan: "free",
      isTrial: true,
      isWorkspaceCovered: false,
    }),
    "currentPlan"
  );
});

test("a signed-out user is routed to onboarding, not a checkout", () => {
  assert.equal(
    decideProPlanCardCta({
      isSignedIn: false,
      planStateKnown: true,
      isPersonallySubscribed: false,
      isStoreBilled: false,
      plan: "free",
      isTrial: false,
      isWorkspaceCovered: false,
    }),
    "signUp"
  );
});

test("a mobile-app subscriber is never offered a Stripe checkout or switch (#2535)", () => {
  const decide = (o) =>
    decideProPlanCardCta({
      isSignedIn: true,
      planStateKnown: true,
      isPersonallySubscribed: false,
      isStoreBilled: true,
      plan: "pro",
      isTrial: false,
      isWorkspaceCovered: false,
      ...o,
    });
  assert.equal(decide({}), "currentPlan");
  assert.equal(decide({ isTrial: true }), "currentPlan");
  // Stripe's switch-plan can't move a store subscription to Pro.
  assert.equal(decide({ plan: "business" }), "none");
  // A workspace seat outranks the store plan, as in the account row.
  assert.equal(decide({ isWorkspaceCovered: true }), "coveredByWorkspace");
  assert.equal(decide({ isWorkspaceCovered: true, plan: "business" }), "coveredByWorkspace");
});

const resolve = (o) =>
  resolveAccountPlan({
    isTrial: false,
    isPastDue: false,
    isPersonallySubscribed: false,
    storeBilling: null,
    isWorkspaceCovered: false,
    hasPeriodEnd: true,
    hasCoveringWorkspaceNames: false,
    ...o,
  });
const appStore = (status = "active") => ({ store: "app_store", status });

test("the account row shows a mobile-app plan and sends billing to the store (#2535)", () => {
  assert.deepEqual(resolve({ storeBilling: appStore() }), {
    row: "store",
    description: "nextBilling",
    action: "manageInStore",
  });
  assert.deepEqual(resolve({ storeBilling: appStore("past_due") }), {
    row: "store",
    description: "storePaymentIssue",
    action: "manageInStore",
  });
  // Still entitled until the paid period ends, but it won't renew.
  assert.deepEqual(resolve({ storeBilling: appStore("canceled") }), {
    row: "store",
    description: "accessUntil",
    action: "manageInStore",
  });
  // A non-expiring purchase has no period end.
  assert.deepEqual(resolve({ storeBilling: appStore(), hasPeriodEnd: false }), {
    row: "store",
    description: "unlimited",
    action: "manageInStore",
  });
  // A store trial is still a trial, but upgrading through Stripe would bill twice.
  assert.deepEqual(resolve({ isTrial: true, storeBilling: appStore("trialing") }), {
    row: "trial",
    description: "trial",
    action: "manageInStore",
  });
  // An API that doesn't name the store gets a note, never a guessed link.
  assert.deepEqual(resolve({ storeBilling: { store: null, status: "active" } }), {
    row: "store",
    description: "nextBilling",
    action: "storeNote",
  });
});

test("a workspace seat outranks a store plan in the row, but the store keeps the button", () => {
  assert.deepEqual(
    resolve({
      storeBilling: appStore(),
      isWorkspaceCovered: true,
      hasCoveringWorkspaceNames: true,
    }),
    { row: "workspaceOrFree", description: "providedBy", action: "manageInStore" }
  );
  // Before the workspace store loads there are no names to show yet.
  assert.deepEqual(resolve({ storeBilling: appStore("past_due"), isWorkspaceCovered: true }), {
    row: "workspaceOrFree",
    description: "unlimited",
    action: "manageInStore",
  });
});

test("the account row keeps its existing Stripe, workspace and free paths", () => {
  assert.deepEqual(resolve({ isPersonallySubscribed: true }), {
    row: "personal",
    description: "nextBilling",
    action: "manageBilling",
  });
  assert.deepEqual(resolve({ isPersonallySubscribed: true, hasPeriodEnd: false }), {
    row: "personal",
    description: "unlimited",
    action: "manageBilling",
  });
  assert.deepEqual(resolve({ isPersonallySubscribed: true, isTrial: true }), {
    row: "trial",
    description: "trial",
    action: "upgrade",
  });
  assert.deepEqual(resolve({ isPastDue: true }), {
    row: "pastDue",
    description: "pastDue",
    action: "updatePayment",
  });
  // A trial outranks past due in the row; the recovery button still shows.
  assert.deepEqual(resolve({ isTrial: true, isPastDue: true }), {
    row: "trial",
    description: "trial",
    action: "updatePayment",
  });
  assert.deepEqual(resolve({ isWorkspaceCovered: true, hasCoveringWorkspaceNames: true }), {
    row: "workspaceOrFree",
    description: "providedBy",
    action: "none",
  });
  assert.deepEqual(resolve({ isWorkspaceCovered: true }), {
    row: "workspaceOrFree",
    description: "unlimited",
    action: "none",
  });
  assert.deepEqual(resolve({}), {
    row: "workspaceOrFree",
    description: "freeUsage",
    action: "upgrade",
  });
});

test("each store links to its own subscriptions page", () => {
  assert.equal(storeSubscriptionsUrl("app_store"), "https://apps.apple.com/account/subscriptions");
  assert.equal(
    storeSubscriptionsUrl("play_store"),
    "https://play.google.com/store/account/subscriptions"
  );
});
