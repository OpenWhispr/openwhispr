const test = require("node:test");
const assert = require("node:assert/strict");
const {
  installBrowserGlobals,
  resetBrowserGlobals,
} = require("./harness/browserGlobals");

test("a standby renderer takes ownership after the active renderer releases it", async (t) => {
  installBrowserGlobals();
  t.after(resetBrowserGlobals);
  const managed = await import("../../src/components/onboarding/managedLocalModels.ts");
  assert.equal(typeof managed.runWithManagedLocalModelReconciliationLock, "function");

  let releaseOwner;
  let ownerEntered;
  const entered = new Promise((resolve) => {
    ownerEntered = resolve;
  });
  const first = managed.runWithManagedLocalModelReconciliationLock(async () => {
    ownerEntered();
    await new Promise((resolve) => {
      releaseOwner = resolve;
    });
  });
  await entered;

  let standbyEntered = false;
  const standby = managed.runWithManagedLocalModelReconciliationLock(async () => {
    standbyEntered = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(standbyEntered, false);

  releaseOwner();
  assert.equal(await first, true);
  assert.equal(await standby, true);
  assert.equal(standbyEntered, true);
});
