const test = require("node:test");
const assert = require("node:assert/strict");

const { decideUpsell } = require("../../src/lib/upsell.ts");

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
