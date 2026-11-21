const test = require("node:test");
const assert = require("node:assert/strict");

const { CONTACT_SALES_URL } = require("../../src/lib/contactSales.ts");
const {
  billingIntervalChoice,
  isPortalAction,
  personalBusyAction,
  personalProCardKind,
  runBusinessTileAction,
  runEnterpriseTileAction,
  runPersonalAction,
} = require("../../src/components/settings/billing/personalGridHandlers.ts");

function recorder() {
  const calls = [];
  const handlers = {
    subscribePro: () => calls.push(["subscribePro"]),
    openBillingPortal: () => calls.push(["openBillingPortal"]),
    openExternal: (url) => calls.push(["openExternal", url]),
    signIn: () => calls.push(["signIn"]),
    retry: () => calls.push(["retry"]),
    viewWorkspace: (workspaceId) => calls.push(["viewWorkspace", workspaceId]),
    createWorkspace: () => calls.push(["createWorkspace"]),
  };
  return { calls, handlers };
}

const ready = (actions = []) => ({
  kind: "ready",
  tier: "free",
  badge: null,
  price: { key: "price.free" },
  actions,
  banners: [],
  usage: [],
  details: [],
});

const usage = (overrides = {}) => ({
  isPersonallySubscribed: false,
  isPastDue: false,
  isTrial: false,
  plan: "free",
  storeBilling: null,
  entitledWorkspaceIds: [],
  ...overrides,
});

test("the contact-sales URL is the one the old grid opened", () => {
  assert.equal(CONTACT_SALES_URL, "https://openwhispr.com/contact-sales");
});

test("Pro card: signed out asks to sign in, whatever the state says", () => {
  assert.equal(
    personalProCardKind({ signedIn: false, state: { kind: "signedOut" }, usage: null }),
    "signIn"
  );
});

test("Pro card: a list led by subscribePro offers checkout", () => {
  assert.equal(
    personalProCardKind({
      signedIn: true,
      state: ready([{ kind: "subscribePro" }, { kind: "business", action: { kind: "none" } }]),
      usage: usage(),
    }),
    "subscribe"
  );
});

test("Pro card: Stripe Pro is the current plan", () => {
  const stripePro = usage({ isPersonallySubscribed: true, plan: "pro" });
  assert.equal(
    personalProCardKind({
      signedIn: true,
      state: ready([{ kind: "manageBilling" }]),
      usage: stripePro,
    }),
    "current"
  );
  // A covered Stripe Pro member still pays for Pro, so Pro stays their plan.
  assert.equal(
    personalProCardKind({
      signedIn: true,
      state: ready([{ kind: "manageBilling" }]),
      usage: { ...stripePro, entitledWorkspaceIds: ["ws-1"] },
    }),
    "current"
  );
});

test("Pro card: a covered cardless trial is covered, never Your plan", () => {
  assert.equal(
    personalProCardKind({
      signedIn: true,
      state: ready([]),
      usage: usage({
        isPersonallySubscribed: true,
        isTrial: true,
        plan: "pro",
        entitledWorkspaceIds: ["ws-1"],
      }),
    }),
    "covered"
  );
});

test("Pro card: a past due plan offers nothing, covered or not", () => {
  const pastDue = usage({ isPastDue: true, plan: "pro" });
  const state = ready([{ kind: "manageBilling" }]);
  assert.equal(personalProCardKind({ signedIn: true, state, usage: pastDue }), "none");
  assert.equal(
    personalProCardKind({
      signedIn: true,
      state,
      usage: { ...pastDue, entitledWorkspaceIds: ["ws-1"] },
    }),
    "none"
  );
});

test("Pro card: personal Stripe Business offers the downgrade", () => {
  assert.equal(
    personalProCardKind({
      signedIn: true,
      state: ready([{ kind: "manageBilling" }]),
      usage: usage({ isPersonallySubscribed: true, plan: "business" }),
    }),
    "downgrade"
  );
});

test("Pro card: a covered free member is covered", () => {
  assert.equal(
    personalProCardKind({
      signedIn: true,
      state: ready([]),
      usage: usage({ entitledWorkspaceIds: ["ws-1"], plan: "business" }),
    }),
    "covered"
  );
});

test("Pro card: a store-billed Pro subscriber is on Pro, covered or not", () => {
  const storePro = usage({ plan: "pro", storeBilling: { store: "app_store", status: "active" } });
  const state = ready([{ kind: "manageInStore", store: "app_store" }]);
  assert.equal(personalProCardKind({ signedIn: true, state, usage: storePro }), "current");
  assert.equal(
    personalProCardKind({
      signedIn: true,
      state: ready([]),
      usage: { ...storePro, storeBilling: { store: null, status: "active" } },
    }),
    "current"
  );
  assert.equal(
    personalProCardKind({
      signedIn: true,
      state: ready([]),
      usage: { ...storePro, entitledWorkspaceIds: ["ws-1"] },
    }),
    "current"
  );
});

test("Pro card: store-billed Business, loading, failure or no usage shows nothing", () => {
  const storeBusiness = usage({
    plan: "business",
    storeBilling: { store: "play_store", status: "active" },
  });
  assert.equal(
    personalProCardKind({ signedIn: true, state: ready([]), usage: storeBusiness }),
    "none"
  );
  for (const state of [{ kind: "loading" }, { kind: "failed" }]) {
    assert.equal(personalProCardKind({ signedIn: true, state, usage: usage() }), "none");
  }
  assert.equal(personalProCardKind({ signedIn: true, state: ready([]), usage: null }), "none");
});

test("Business tile: viewWorkspace switches to that workspace, createWorkspace opens the dialog for Business", () => {
  const { calls, handlers } = recorder();
  runBusinessTileAction({ kind: "viewWorkspace", workspaceId: "ws-9" }, handlers);
  runBusinessTileAction({ kind: "createWorkspace" }, handlers);
  runBusinessTileAction({ kind: "none" }, handlers);
  runBusinessTileAction({ kind: "workspacePlan" }, handlers);
  assert.deepEqual(calls, [["viewWorkspace", "ws-9"], ["createWorkspace"]]);
});

test("Enterprise: Upgrade a workspace switches the view and contact sales opens the page; nothing starts a checkout", () => {
  const { calls, handlers } = recorder();
  runEnterpriseTileAction({ kind: "viewWorkspace", workspaceId: "ws-3" }, handlers);
  runEnterpriseTileAction({ kind: "contactSales", ownerName: "Ada" }, handlers);
  runEnterpriseTileAction({ kind: "workspacePlan" }, handlers);
  runEnterpriseTileAction({ kind: "none" }, handlers);
  // Personal never sells a workspace plan, even if handed a checkout.
  runEnterpriseTileAction({ kind: "checkout" }, handlers);
  assert.deepEqual(calls, [
    ["viewWorkspace", "ws-3"],
    ["openExternal", "https://openwhispr.com/contact-sales"],
  ]);
});

test("Personal actions: portal actions open the Stripe portal, the rest reach their handler", () => {
  const { calls, handlers } = recorder();
  for (const action of [
    { kind: "subscribePro" },
    { kind: "manageBilling" },
    { kind: "updatePayment" },
    { kind: "cancelPro" },
    { kind: "manageInStore", store: "app_store" },
    { kind: "manageInStore", store: "play_store" },
    { kind: "signIn" },
    { kind: "retry" },
    { kind: "business", action: { kind: "viewWorkspace", workspaceId: "ws-2" } },
    { kind: "business", action: { kind: "createWorkspace" } },
  ]) {
    runPersonalAction(action, handlers);
  }
  assert.deepEqual(calls, [
    ["subscribePro"],
    ["openBillingPortal"],
    ["openBillingPortal"],
    ["openBillingPortal"],
    ["openExternal", "https://apps.apple.com/account/subscriptions"],
    ["openExternal", "https://play.google.com/store/account/subscriptions"],
    ["signIn"],
    ["retry"],
    ["viewWorkspace", "ws-2"],
    ["createWorkspace"],
  ]);
});

test("isPortalAction: exactly the actions that open the Stripe portal", () => {
  const portal = ["manageBilling", "updatePayment", "cancelPro"];
  for (const kind of portal) assert.equal(isPortalAction(kind), true, kind);
  for (const kind of ["subscribePro", "manageInStore", "signIn", "retry", "business"]) {
    assert.equal(isPortalAction(kind), false, kind);
  }
  assert.equal(isPortalAction(null), false);
});

test("billingIntervalChoice maps the yearly switch to the checkout interval", () => {
  assert.equal(billingIntervalChoice(true), "annual");
  assert.equal(billingIntervalChoice(false), "monthly");
});

test("personalBusyAction: checkout beats retry beats the clicked portal action", () => {
  const idle = { proCheckoutOpening: false, isRetrying: false, isOpeningBilling: false };
  assert.equal(personalBusyAction({ ...idle, portalAction: "cancelPro" }), null);
  assert.equal(
    personalBusyAction({ ...idle, proCheckoutOpening: true, isRetrying: true, portalAction: null }),
    "subscribePro"
  );
  assert.equal(personalBusyAction({ ...idle, isRetrying: true, portalAction: null }), "retry");
  assert.equal(
    personalBusyAction({ ...idle, isOpeningBilling: true, portalAction: "manageBilling" }),
    "manageBilling"
  );
  assert.equal(personalBusyAction({ ...idle, isOpeningBilling: true, portalAction: null }), null);
});

test("Cancel Business and Keep Business each open the personal Stripe portal once", () => {
  const { calls, handlers } = recorder();
  for (const action of [{ kind: "cancelBusiness" }, { kind: "keepPlan", plan: "Business" }]) {
    assert.equal(isPortalAction(action.kind), true);
    runPersonalAction(action, handlers);
  }
  assert.deepEqual(calls, [["openBillingPortal"], ["openBillingPortal"]]);
});
