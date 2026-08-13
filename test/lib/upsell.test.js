const test = require("node:test");
const assert = require("node:assert/strict");

const { decideUpsell, decideProPlanCardCta } = require("../../src/lib/upsell.ts");

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
      plan: "free",
      isTrial: false,
      isWorkspaceCovered: false,
    }),
    "signUp"
  );
});
