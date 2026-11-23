const assert = require("node:assert/strict");
const test = require("node:test");
const {
  currentBillingIdentity,
  isSameBillingIdentity,
} = require("../../src/lib/billingRequestIdentity.ts");

test("identities match only on the same workspace and sign-in", () => {
  const a = { workspaceId: "a", authGeneration: 7 };
  assert.equal(isSameBillingIdentity(a, { workspaceId: "a", authGeneration: 7 }), true);
  assert.equal(isSameBillingIdentity(a, { workspaceId: "b", authGeneration: 7 }), false);
  assert.equal(isSameBillingIdentity(a, { workspaceId: "a", authGeneration: 8 }), false);
  assert.equal(isSameBillingIdentity(a, null), false);
  assert.equal(isSameBillingIdentity(null, null), false);
});

test("there is no billing identity without a validated sign-in", () => {
  assert.equal(currentBillingIdentity("a"), null);
});
