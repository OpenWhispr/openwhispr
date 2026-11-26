const assert = require("node:assert/strict");
const test = require("node:test");

const ID = "3f2b8c1e-9a4d-4e6f-8b1a-2c3d4e5f6a7b";

test("isPlansBillingTarget accepts Personal and a workspace UUID only", async () => {
  const { isPlansBillingTarget, plansBillingTarget } =
    await import("../../src/helpers/settingsTargets.js");
  assert.equal(isPlansBillingTarget("plansBilling"), true);
  assert.equal(isPlansBillingTarget(plansBillingTarget(ID)), true);
  assert.equal(isPlansBillingTarget(plansBillingTarget(ID.toUpperCase())), true);
  assert.equal(isPlansBillingTarget("plansBilling:workspace:"), false);
  assert.equal(isPlansBillingTarget("plansBilling:workspace:../etc"), false);
  assert.equal(isPlansBillingTarget(`plansBilling:workspace:${ID}:extra`), false);
  assert.equal(isPlansBillingTarget(undefined), false);
});
