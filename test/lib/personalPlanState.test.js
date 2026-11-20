const test = require("node:test");
const assert = require("node:assert/strict");

const { personalPlanState, showsCreatorLink } = require("../../src/lib/personalPlanState.ts");
const {
  personalProCardKind,
} = require("../../src/components/settings/billing/personalGridHandlers.ts");
const { isPastDueUsage, normalizeUsage, storeBillingOf } = require("../../src/lib/usageStore.ts");

const PERIOD_END = "2026-12-20T00:00:00.000Z";
const VIEW_WORKSPACE = { kind: "viewWorkspace", workspaceId: "ws-1" };

function usage(overrides = {}) {
  return {
    status: "success",
    plan: "free",
    isTrial: false,
    trialDaysLeft: null,
    isPastDue: false,
    isSubscribed: false,
    isPersonallySubscribed: false,
    storeBilling: null,
    currentPeriodEnd: null,
    billingInterval: null,
    wordsUsed: 100,
    limit: 2000,
    wordsRemaining: 1900,
    isOverLimit: false,
    isApproachingLimit: false,
    entitledWorkspaceIds: [],
    ...overrides,
  };
}

const STRIPE_PRO = {
  plan: "pro",
  isSubscribed: true,
  isPersonallySubscribed: true,
  currentPeriodEnd: PERIOD_END,
  billingInterval: "monthly",
};

// The referral trial (openwhispr-api lib/referrals.ts): personally entitled, but no Stripe
// subscription and no period, so nothing to manage in the portal.
const TRIAL = {
  plan: "pro",
  isTrial: true,
  trialDaysLeft: 5,
  isSubscribed: true,
  isPersonallySubscribed: true,
  currentPeriodEnd: null,
  billingInterval: null,
};

// past_due is not an entitled status, so the API reports no personal entitlement.
const PAST_DUE = {
  ...STRIPE_PRO,
  isPastDue: true,
  isSubscribed: false,
  isPersonallySubscribed: false,
};

const COVERED = { entitledWorkspaceIds: ["ws-1"], isSubscribed: true, plan: "business" };

function store(status = "active", name = "app_store") {
  return {
    plan: "pro",
    isSubscribed: true,
    storeBilling: { store: name, status },
    currentPeriodEnd: PERIOD_END,
    billingInterval: "monthly",
  };
}

function state(usageOverrides = {}, inputOverrides = {}) {
  return personalPlanState({
    signedIn: true,
    usage: usage(usageOverrides),
    coveringWorkspaceNames: [],
    businessAction: VIEW_WORKSPACE,
    ...inputOverrides,
  });
}

function ready(usageOverrides, inputOverrides) {
  const result = state(usageOverrides, inputOverrides);
  assert.equal(result.kind, "ready");
  return result;
}

const actionKinds = (result) => result.actions.map((action) => action.kind);
const bannerIds = (result) => result.banners.map((banner) => banner.id);
const banner = (result, id) => result.banners.find((entry) => entry.id === id);

test("signed out, unknown usage and a failed fetch are their own states", () => {
  assert.deepEqual(
    personalPlanState({
      signedIn: false,
      usage: null,
      coveringWorkspaceNames: [],
      businessAction: VIEW_WORKSPACE,
    }),
    { kind: "signedOut" }
  );
  assert.deepEqual(state({}, { usage: null }), { kind: "loading" });
  assert.deepEqual(state({ status: "loading" }), { kind: "loading" });
  assert.deepEqual(state({ status: "idle" }), { kind: "loading" });
  assert.deepEqual(state({ status: "error" }), { kind: "failed" });
});

test("tier: personal billing reads its plan, a trial and a past due plan keep theirs, everything else is Free", () => {
  assert.equal(ready(STRIPE_PRO).tier, "pro");
  assert.equal(ready({ ...STRIPE_PRO, plan: "business" }).tier, "business");
  assert.equal(ready(store()).tier, "pro");
  assert.equal(ready({ ...store(), plan: "business" }).tier, "business");
  assert.equal(ready(TRIAL).tier, "pro");
  assert.equal(ready(PAST_DUE).tier, "pro");
  assert.equal(ready({ ...PAST_DUE, plan: "business" }).tier, "business");
  assert.equal(ready(COVERED).tier, "free");
  assert.equal(ready().tier, "free");
});

test("free solo: Pro leads, then Business; no banners; a normal words row", () => {
  const result = ready();
  assert.deepEqual(actionKinds(result), ["subscribePro", "business"]);
  assert.deepEqual(result.actions[1], { kind: "business", action: VIEW_WORKSPACE });
  assert.deepEqual(result.banners, []);
  assert.deepEqual(result.usage, [
    { kind: "words", used: 100, limit: 2000, remaining: 1900, tone: "normal" },
  ]);
  assert.equal(result.badge, null);
  assert.deepEqual(result.price, { key: "price.free" });
  assert.deepEqual(result.details, []);
});

test("free approaching the limit gets a warning words row", () => {
  const result = ready({ isApproachingLimit: true });
  assert.equal(result.usage[0].tone, "warning");
  assert.deepEqual(result.banners, []);
});

test("free over the limit gets a destructive words row and the weekly limit banner", () => {
  const result = ready({ isOverLimit: true, isApproachingLimit: true, wordsRemaining: 0 });
  assert.equal(result.usage[0].tone, "destructive");
  assert.deepEqual(bannerIds(result), ["weeklyLimit"]);
  const weekly = banner(result, "weeklyLimit");
  assert.equal(weekly.tone, "warning");
  assert.equal(weekly.titleKey, "banners.weeklyLimit.title");
  assert.equal(weekly.action, undefined);
});

test("free covered by a workspace: no actions, the covered banner, unlimited usage", () => {
  const result = ready(COVERED, { coveringWorkspaceNames: ["Acme", "Other"] });
  assert.deepEqual(result.actions, []);
  assert.deepEqual(bannerIds(result), ["covered"]);
  const covered = banner(result, "covered");
  assert.equal(covered.tone, "warning");
  assert.equal(covered.titleKey, "banners.covered.title");
  assert.deepEqual(covered.params, { workspace: "Acme" });
  assert.equal(covered.action, undefined);
  assert.deepEqual(result.usage, [{ kind: "unlimited" }]);
});

test("covered before the workspace names load uses the unnamed variant", () => {
  const result = ready(COVERED);
  const covered = banner(result, "covered");
  assert.equal(covered.titleKey, "banners.coveredUnnamed.title");
  assert.equal(covered.params?.workspace, undefined);
});

test("covered and over a stale limit shows no weekly limit banner", () => {
  const result = ready({ ...COVERED, isOverLimit: true }, { coveringWorkspaceNames: ["Acme"] });
  assert.deepEqual(bannerIds(result), ["covered"]);
});

test("Stripe Pro monthly with a Business workspace plan: only Manage billing, monthly badge", () => {
  const result = ready(STRIPE_PRO, { businessAction: { kind: "workspacePlan" } });
  assert.deepEqual(actionKinds(result), ["manageBilling"]);
  assert.deepEqual(result.badge, { key: "badges.monthly", tone: "info" });
  assert.deepEqual(result.price, { key: "price.proMonthly" });
  assert.deepEqual(result.usage, [{ kind: "unlimited" }]);
  assert.deepEqual(result.details, [
    { labelKey: "details.periodEnds", value: { kind: "date", iso: PERIOD_END } },
  ]);
});

test("Stripe Pro keeps the Business action unless it is none or workspacePlan", () => {
  assert.deepEqual(actionKinds(ready(STRIPE_PRO)), ["manageBilling", "business"]);
  assert.deepEqual(actionKinds(ready(STRIPE_PRO, { businessAction: { kind: "none" } })), [
    "manageBilling",
  ]);
  assert.deepEqual(actionKinds(ready({}, { businessAction: { kind: "none" } })), ["subscribePro"]);
});

test("Stripe Pro without a period end has no details", () => {
  assert.deepEqual(ready({ ...STRIPE_PRO, currentPeriodEnd: null }).details, []);
});

test("personal Stripe Business has no price line", () => {
  assert.equal(ready({ ...STRIPE_PRO, plan: "business" }).price, null);
});

test("Stripe Pro annual: yearly badge and billed yearly price", () => {
  const result = ready({ ...STRIPE_PRO, billingInterval: "annual" });
  assert.deepEqual(result.badge, { key: "badges.yearly", tone: "info" });
  assert.deepEqual(result.price, { key: "price.billedYearly" });
});

test("cardless trial: days badge, Subscribe to Pro leads, no price, no details", () => {
  const result = ready(TRIAL);
  assert.deepEqual(result.badge, { key: "badges.trial", params: { days: "5" }, tone: "info" });
  assert.deepEqual(actionKinds(result), ["subscribePro", "business"]);
  assert.equal(result.price, null);
  assert.deepEqual(result.details, []);
  assert.deepEqual(result.banners, []);
  assert.deepEqual(result.usage, [{ kind: "unlimited" }]);
});

test("a cardless trial never offers the Stripe portal, whatever its period end says", () => {
  const result = ready({ ...TRIAL, currentPeriodEnd: PERIOD_END, billingInterval: "monthly" });
  assert.deepEqual(actionKinds(result), ["subscribePro", "business"]);
  assert.equal(result.price, null);
  assert.deepEqual(result.details, []);
});

test("past due: payment failed banner with Update payment, past due badge, words row", () => {
  const result = ready(PAST_DUE);
  assert.equal(result.tier, "pro");
  assert.deepEqual(actionKinds(result), ["manageBilling"]);
  assert.deepEqual(bannerIds(result), ["paymentFailed"]);
  const failed = banner(result, "paymentFailed");
  assert.equal(failed.tone, "destructive");
  assert.deepEqual(failed.action, { kind: "updatePayment" });
  assert.deepEqual(result.badge, { key: "badges.pastDue", tone: "destructive" });
  assert.deepEqual(result.price, { key: "price.proMonthly" });
  assert.equal(result.usage[0].kind, "words");
  assert.deepEqual(result.details, [
    { labelKey: "details.periodEnds", value: { kind: "date", iso: PERIOD_END } },
  ]);
});

test("covered Stripe Pro: covered paying banner with Cancel Pro", () => {
  const result = ready(
    { ...STRIPE_PRO, entitledWorkspaceIds: ["ws-1"] },
    { coveringWorkspaceNames: ["Acme"] }
  );
  assert.deepEqual(bannerIds(result), ["coveredPaying"]);
  const paying = banner(result, "coveredPaying");
  assert.equal(paying.tone, "warning");
  assert.equal(paying.titleKey, "banners.coveredPaying.title");
  assert.deepEqual(paying.params, { workspace: "Acme", plan: "Pro" });
  assert.deepEqual(paying.action, { kind: "cancelPro" });
  assert.deepEqual(result.usage, [{ kind: "unlimited" }]);
});

test("covered cardless trial: no actions and the plain covered banner", () => {
  const result = ready(
    { ...TRIAL, entitledWorkspaceIds: ["ws-1"] },
    { coveringWorkspaceNames: ["Acme"] }
  );
  assert.deepEqual(result.actions, []);
  assert.deepEqual(bannerIds(result), ["covered"]);
  const covered = banner(result, "covered");
  assert.deepEqual(covered.params, { workspace: "Acme" });
  assert.equal(covered.action, undefined);
  assert.equal(result.price, null);
});

test("covered past due: Manage billing and the covered past due banner, never payment failed", () => {
  const result = ready(
    { ...PAST_DUE, isSubscribed: true, entitledWorkspaceIds: ["ws-1"] },
    { coveringWorkspaceNames: ["Acme"] }
  );
  assert.deepEqual(actionKinds(result), ["manageBilling"]);
  assert.deepEqual(bannerIds(result), ["coveredPastDue"]);
  const pastDue = banner(result, "coveredPastDue");
  assert.equal(pastDue.tone, "warning");
  assert.deepEqual(pastDue.params, { workspace: "Acme", plan: "Pro" });
  assert.deepEqual(pastDue.action, { kind: "cancelPro" });
  assert.deepEqual(result.usage, [{ kind: "unlimited" }]);
});

test("covered banners name a personal Business plan as Business, named or not", () => {
  const paying = ready({ ...STRIPE_PRO, plan: "business", entitledWorkspaceIds: ["ws-1"] });
  assert.deepEqual(banner(paying, "coveredPaying").params, { plan: "Business" });
  assert.equal(banner(paying, "coveredPaying").titleKey, "banners.coveredPayingUnnamed.title");
  const pastDue = ready(
    { ...PAST_DUE, plan: "business", isSubscribed: true, entitledWorkspaceIds: ["ws-1"] },
    { coveringWorkspaceNames: ["Acme"] }
  );
  assert.deepEqual(banner(pastDue, "coveredPastDue").params, {
    workspace: "Acme",
    plan: "Business",
  });
});

test("App Store: Manage in store, billed through and renews details", () => {
  const result = ready(store());
  assert.deepEqual(result.actions, [{ kind: "manageInStore", store: "app_store" }]);
  assert.deepEqual(result.details, [
    { labelKey: "details.billedThrough", value: { kind: "storeName", store: "app_store" } },
    { labelKey: "details.renews", value: { kind: "date", iso: PERIOD_END } },
  ]);
  assert.deepEqual(result.badge, { key: "badges.monthly", tone: "info" });
  assert.deepEqual(result.banners, []);
  assert.equal(result.price, null);
});

test("store trial: trial badge, Manage in store, no price the store may not charge", () => {
  const result = ready({ ...store("trialing"), isTrial: true, trialDaysLeft: 3 });
  assert.deepEqual(result.badge, { key: "badges.trial", params: { days: "3" }, tone: "info" });
  assert.deepEqual(result.actions, [{ kind: "manageInStore", store: "app_store" }]);
  assert.equal(result.price, null);
});

test("canceled store plan: cancelled badge and access until detail", () => {
  const result = ready(store("canceled"));
  assert.deepEqual(result.badge, { key: "badges.cancelled", tone: "destructive" });
  assert.deepEqual(result.details[1], {
    labelKey: "details.accessUntil",
    value: { kind: "date", iso: PERIOD_END },
  });
});

test("store renewal failure: past due badge and store renewal failed banner", () => {
  const result = ready(store("past_due"));
  assert.deepEqual(result.badge, { key: "badges.pastDue", tone: "destructive" });
  assert.deepEqual(bannerIds(result), ["storeRenewalFailed"]);
  assert.equal(banner(result, "storeRenewalFailed").tone, "destructive");
  assert.equal(banner(result, "storeRenewalFailed").action, undefined);
});

test("store with no name: no actions and a null store name", () => {
  const result = ready(store("active", null));
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.details[0], {
    labelKey: "details.billedThrough",
    value: { kind: "storeName", store: null },
  });
});

test("covered store plan: covered store banner without an action", () => {
  const result = ready(
    { ...store(), entitledWorkspaceIds: ["ws-1"] },
    { coveringWorkspaceNames: ["Acme"] }
  );
  assert.deepEqual(bannerIds(result), ["coveredStore"]);
  const covered = banner(result, "coveredStore");
  assert.equal(covered.tone, "warning");
  assert.deepEqual(covered.params, { workspace: "Acme" });
  assert.equal(covered.action, undefined);
});

test("a covered free member shows no billing interval badge", () => {
  assert.equal(ready({ ...COVERED, billingInterval: "annual" }).badge, null);
});

test("Pro leads every uncovered Free action list", () => {
  const businessActions = [
    VIEW_WORKSPACE,
    { kind: "createWorkspace" },
    { kind: "workspacePlan" },
    { kind: "none" },
  ];
  const usages = [{}, { isApproachingLimit: true }, { isOverLimit: true }];
  for (const businessAction of businessActions) {
    for (const overrides of usages) {
      const result = ready(overrides, { businessAction });
      assert.equal(result.tier, "free");
      assert.equal(result.actions[0].kind, "subscribePro");
    }
  }
});

test("every banner carries title and body keys under its id", () => {
  const result = ready(PAST_DUE);
  assert.deepEqual(
    { titleKey: result.banners[0].titleKey, bodyKey: result.banners[0].bodyKey },
    { titleKey: "banners.paymentFailed.title", bodyKey: "banners.paymentFailed.body" }
  );
});

// What useUsage hands the view, from a raw /api/usage payload (src/hooks/useUsage.ts).
function fromApi(response) {
  const data = normalizeUsage(response);
  const isSubscribed = data.isSubscribed;
  const isOverLimit = !isSubscribed && data.limit > 0 && data.wordsUsed >= data.limit;
  return {
    status: "success",
    plan: data.plan,
    isTrial: data.isTrial,
    trialDaysLeft: data.trialDaysLeft,
    isPastDue: isPastDueUsage(data),
    isSubscribed,
    isPersonallySubscribed: data.entitlementSources.personal,
    storeBilling: storeBillingOf(data),
    currentPeriodEnd: data.currentPeriodEnd,
    billingInterval: data.billingInterval,
    wordsUsed: data.wordsUsed,
    limit: data.limit,
    wordsRemaining: data.wordsRemaining,
    isOverLimit,
    isApproachingLimit:
      !isSubscribed && data.limit > 0 && data.wordsUsed >= data.limit * 0.8 && !isOverLimit,
    entitledWorkspaceIds: data.entitlementSources.workspaceIds,
  };
}

// Shaped as openwhispr-api lib/usage.ts getUsage returns them.
function apiPayload(overrides = {}, sources = {}) {
  return {
    wordsUsed: 100,
    wordsRemaining: 1900,
    limit: 2000,
    plan: "free",
    status: "active",
    isSubscribed: false,
    isTrial: false,
    trialDaysLeft: null,
    currentPeriodEnd: null,
    billingInterval: null,
    resetAt: "rolling",
    ...overrides,
    entitlementSources: {
      personal: false,
      provider: false,
      providerStore: null,
      workspaceIds: [],
      ...sources,
    },
  };
}

const SUBSCRIBED = { wordsRemaining: -1, limit: -1, isSubscribed: true };
const API = {
  free: apiPayload(),
  stripePro: apiPayload(
    { ...SUBSCRIBED, plan: "pro", currentPeriodEnd: PERIOD_END, billingInterval: "monthly" },
    { personal: true }
  ),
  storePro: apiPayload(
    { ...SUBSCRIBED, plan: "pro", currentPeriodEnd: PERIOD_END, billingInterval: "monthly" },
    { provider: true, providerStore: "app_store" }
  ),
  // A referral trial's row keeps whatever period an old subscription left behind.
  cardlessTrial: apiPayload(
    { ...SUBSCRIBED, plan: "pro", status: "trialing", isTrial: true, trialDaysLeft: 12 },
    { personal: true }
  ),
  pastDue: apiPayload({
    plan: "pro",
    status: "past_due",
    currentPeriodEnd: PERIOD_END,
    billingInterval: "monthly",
  }),
};

function covered(payload) {
  return {
    ...payload,
    ...SUBSCRIBED,
    entitlementSources: { ...payload.entitlementSources, workspaceIds: ["ws-1"] },
  };
}

function fromPayload(payload) {
  const usageResult = fromApi(payload);
  const result = state(usageResult, { usage: usageResult, coveringWorkspaceNames: ["Acme"] });
  assert.equal(result.kind, "ready");
  return {
    result,
    proCard: personalProCardKind({ signedIn: true, state: result, usage: usageResult }),
  };
}

test("API: free solo subscribes to Pro", () => {
  const { result, proCard } = fromPayload(API.free);
  assert.equal(result.tier, "free");
  assert.deepEqual(actionKinds(result), ["subscribePro", "business"]);
  assert.equal(proCard, "subscribe");
});

test("API: active Stripe Pro manages billing and Pro is the current plan", () => {
  const { result, proCard } = fromPayload(API.stripePro);
  assert.equal(result.tier, "pro");
  assert.deepEqual(actionKinds(result), ["manageBilling", "business"]);
  assert.deepEqual(result.price, { key: "price.proMonthly" });
  assert.equal(proCard, "current");
});

test("API: store Pro manages in the store, with no price line", () => {
  const { result, proCard } = fromPayload(API.storePro);
  assert.equal(result.tier, "pro");
  assert.deepEqual(result.actions, [{ kind: "manageInStore", store: "app_store" }]);
  assert.equal(result.price, null);
  assert.equal(proCard, "current");
});

test("API: an uncovered cardless trial can subscribe to Pro and is never sent to the portal", () => {
  const { result, proCard } = fromPayload(API.cardlessTrial);
  assert.equal(result.tier, "pro");
  assert.deepEqual(actionKinds(result), ["subscribePro", "business"]);
  assert.equal(result.price, null);
  assert.deepEqual(result.banners, []);
  assert.equal(proCard, "subscribe");
});

test("API: a covered cardless trial gets the plain covered banner and nothing to pay or cancel", () => {
  const { result, proCard } = fromPayload(covered(API.cardlessTrial));
  assert.deepEqual(result.actions, []);
  assert.deepEqual(bannerIds(result), ["covered"]);
  assert.equal(proCard, "covered");
});

test("API: an uncovered past due payer keeps Pro, fixes payment in the portal, no Subscribe", () => {
  const { result, proCard } = fromPayload(API.pastDue);
  assert.equal(result.tier, "pro");
  assert.deepEqual(actionKinds(result), ["manageBilling"]);
  assert.deepEqual(bannerIds(result), ["paymentFailed"]);
  assert.deepEqual(result.badge, { key: "badges.pastDue", tone: "destructive" });
  assert.deepEqual(result.price, { key: "price.proMonthly" });
  assert.equal(proCard, "none");
});

test("API: a covered past due payer keeps the portal and can cancel Pro", () => {
  const { result, proCard } = fromPayload(covered(API.pastDue));
  assert.equal(result.tier, "pro");
  assert.deepEqual(actionKinds(result), ["manageBilling"]);
  assert.deepEqual(bannerIds(result), ["coveredPastDue"]);
  assert.deepEqual(banner(result, "coveredPastDue").action, { kind: "cancelPro" });
  assert.equal(proCard, "none");
});

// A Stripe trial (with a card) is trialing in Stripe, but the webhook clears trial_ends_at,
// so the API reports isTrial false and a personal entitlement: it bills like any Stripe Pro.
test("API: a Stripe-side trialing subscription manages billing, with a price and Pro current", () => {
  const { result, proCard } = fromPayload(
    apiPayload(
      {
        ...SUBSCRIBED,
        plan: "pro",
        status: "trialing",
        isTrial: false,
        currentPeriodEnd: PERIOD_END,
        billingInterval: "monthly",
      },
      { personal: true }
    )
  );
  assert.equal(result.tier, "pro");
  assert.deepEqual(actionKinds(result), ["manageBilling", "business"]);
  assert.deepEqual(result.price, { key: "price.proMonthly" });
  assert.equal(result.badge?.key, "badges.monthly");
  assert.deepEqual(result.banners, []);
  assert.equal(proCard, "current");
});

test("API: a past due personal Business plan stays Business", () => {
  const { result } = fromPayload(apiPayload({ ...API.pastDue, plan: "business" }));
  assert.equal(result.tier, "business");
  assert.equal(result.price, null);
});

test("the creator link shows to anyone who can still subscribe, a cardless trial included", () => {
  assert.equal(showsCreatorLink(null), true);
  assert.equal(showsCreatorLink(usage()), true);
  assert.equal(showsCreatorLink(usage(TRIAL)), true);
  assert.equal(showsCreatorLink(usage(COVERED)), true);
  assert.equal(showsCreatorLink(usage(STRIPE_PRO)), false);
  assert.equal(
    showsCreatorLink(usage({ ...store(), isTrial: true, isPersonallySubscribed: true })),
    false
  );
});
