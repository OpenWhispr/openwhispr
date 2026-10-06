// Test harnesses install partial browser stubs (see
// test/helpers/harness/browserGlobals.js): a `window` with addEventListener but
// no setInterval and no electronAPI, and not every environment defines a bare
// `localStorage` global. Stores must survive being imported into such an
// environment — module-scope wiring that assumes a full browser window broke CI
// on 2026-08-25 when policyRules briefly pulled enterpriseIdentityStore into the
// import graph of harness-based tests ("window.setInterval is not a function").

const test = require("node:test");
const assert = require("node:assert/strict");

// Deliberately partial: no setInterval, no dispatchEvent, no electronAPI, and
// localStorage exists only as a window property, never as a bare global.
const windowStub = {
  addEventListener() {},
  removeEventListener() {},
  localStorage: {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  },
  location: { origin: "https://harness.openwhispr.test" },
};

Object.defineProperty(globalThis, "window", {
  value: windowStub,
  configurable: true,
  writable: true,
});

test("enterpriseIdentityStore imports under a partial window stub", async () => {
  const store = await import("../../src/stores/enterpriseIdentityStore.ts");
  assert.equal(typeof store.useEnterpriseIdentityStore.getState, "function");
  assert.equal(store.useEnterpriseIdentityStore.getState().status, "idle");
});

test("settingsStore imports without a bare localStorage global", async () => {
  assert.equal(typeof localStorage, "undefined");
  const store = await import("../../src/stores/settingsStore.ts");
  assert.equal(typeof store.useSettingsStore.getState, "function");
});
