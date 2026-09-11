const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/utils/macAccessibilityReadiness.ts");

const defaults = {
  normalAppVisible: true,
  isControlPanel: false,
  isSignedIn: false,
  authSkipped: false,
};

test("completed hidden startup accepts the validated main-process account scope", async () => {
  const { resolveMacAccessibilityReadiness } = await load();
  const ready = await resolveMacAccessibilityReadiness({
    ...defaults,
    readActiveAccountScope: async () => ({ accountId: "account-a", authGeneration: 3 }),
  });

  assert.deepEqual(ready, {
    expectedAccountScope: { accountId: "account-a", authGeneration: 3 },
  });
});

test("hidden startup rejects stale completion state without a validated account scope", async () => {
  const { resolveMacAccessibilityReadiness } = await load();
  const ready = await resolveMacAccessibilityReadiness({
    ...defaults,
    readActiveAccountScope: async () => null,
  });

  assert.equal(ready, null);
});

test("hidden startup fails closed when the account scope cannot be read", async () => {
  const { resolveMacAccessibilityReadiness } = await load();
  const ready = await resolveMacAccessibilityReadiness({
    ...defaults,
    readActiveAccountScope: async () => {
      throw new Error("scope unavailable");
    },
  });

  assert.equal(ready, null);
});

test("control panel never substitutes the main-process scope for resolved auth", async () => {
  const { resolveMacAccessibilityReadiness } = await load();
  let scopeRead = false;
  const ready = await resolveMacAccessibilityReadiness({
    ...defaults,
    isControlPanel: true,
    readActiveAccountScope: async () => {
      scopeRead = true;
      return { accountId: "account-a", authGeneration: 3 };
    },
  });

  assert.equal(ready, null);
  assert.equal(scopeRead, false);
});

test("resolved account and guest sessions keep their immediate readiness paths", async () => {
  const { resolveMacAccessibilityReadiness } = await load();

  assert.deepEqual(await resolveMacAccessibilityReadiness({ ...defaults, isSignedIn: true }), {});
  assert.deepEqual(await resolveMacAccessibilityReadiness({ ...defaults, authSkipped: true }), {});
});

test("onboarding remains fail-closed for every authentication state", async () => {
  const { resolveMacAccessibilityReadiness } = await load();

  assert.equal(
    await resolveMacAccessibilityReadiness({
      ...defaults,
      normalAppVisible: false,
      isSignedIn: true,
    }),
    null
  );
});
