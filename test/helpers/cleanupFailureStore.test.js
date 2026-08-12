const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/stores/cleanupFailureStore.ts");

const reset = (store) => store.useCleanupFailureStore.setState({ pending: 0 });

test("recordCleanupFailure increments the pending count", async () => {
  const store = await load();
  reset(store);

  store.recordCleanupFailure();
  assert.equal(store.useCleanupFailureStore.getState().pending, 1);

  store.recordCleanupFailure();
  assert.equal(store.useCleanupFailureStore.getState().pending, 2);
});

test("consumeCleanupFailures returns the pending count and resets it to zero", async () => {
  const store = await load();
  reset(store);

  store.recordCleanupFailure();
  store.recordCleanupFailure();

  assert.equal(store.consumeCleanupFailures(), 2);
  assert.equal(store.useCleanupFailureStore.getState().pending, 0);
});

test("consuming an empty store returns zero, so a re-run cannot toast the same failure twice", async () => {
  const store = await load();
  reset(store);

  assert.equal(store.consumeCleanupFailures(), 0);

  store.recordCleanupFailure();
  assert.equal(store.consumeCleanupFailures(), 1);
  assert.equal(store.consumeCleanupFailures(), 0);
});
