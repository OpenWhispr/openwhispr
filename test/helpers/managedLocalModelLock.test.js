const test = require("node:test");
const assert = require("node:assert/strict");

function createLockQueue() {
  let held = false;
  const queue = [];
  const request = async (_name, callback) => {
    if (held) {
      await new Promise((resolve) => queue.push(resolve));
    }
    held = true;
    try {
      return await callback({ name: "managed-local" });
    } finally {
      held = false;
      queue.shift()?.();
    }
  };
  return { request };
}

test("managed local lock lifetime retains ownership until release and hands it to a successor", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(global, "navigator");
  Object.defineProperty(global, "navigator", {
    value: { locks: createLockQueue() },
    configurable: true,
    writable: true,
  });
  try {
    const { holdManagedLocalModelLock } =
      await import("../../src/components/onboarding/managedLocalModels.ts");
    const events = [];
    const first = holdManagedLocalModelLock({
      onOwnershipChange: (ownsLock) => events.push(`first:${ownsLock}`),
      reconcile: async () => events.push("first:reconcile"),
    });
    await Promise.resolve();
    await Promise.resolve();
    const second = holdManagedLocalModelLock({
      onOwnershipChange: (ownsLock) => events.push(`second:${ownsLock}`),
      reconcile: async () => events.push("second:reconcile"),
    });
    await Promise.resolve();
    assert.deepEqual(events, ["first:true", "first:reconcile"]);

    first.release();
    await first.finished;
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(events, [
      "first:true",
      "first:reconcile",
      "first:false",
      "second:true",
      "second:reconcile",
    ]);

    second.release();
    await second.finished;
    assert.deepEqual(events.at(-1), "second:false");
  } finally {
    if (originalNavigator) Object.defineProperty(global, "navigator", originalNavigator);
    else delete global.navigator;
  }
});

test("a reconciliation rejection is surfaced while the eligible owner retains its lock", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(global, "navigator");
  Object.defineProperty(global, "navigator", {
    value: { locks: createLockQueue() },
    configurable: true,
    writable: true,
  });
  try {
    const { holdManagedLocalModelLock } =
      await import("../../src/components/onboarding/managedLocalModels.ts");
    const events = [];
    const first = holdManagedLocalModelLock({
      onOwnershipChange: (ownsLock) => events.push(`first:${ownsLock}`),
      onReconcileError: (error) => events.push(`first:error:${error.message}`),
      reconcile: async () => {
        throw new Error("inventory unavailable");
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    const second = holdManagedLocalModelLock({
      onOwnershipChange: (ownsLock) => events.push(`second:${ownsLock}`),
      onReconcileError: () => {},
      reconcile: async () => events.push("second:reconcile"),
    });
    await Promise.resolve();
    assert.deepEqual(events, ["first:true", "first:error:inventory unavailable"]);

    first.release();
    await first.finished;
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(events.slice(-2), ["second:true", "second:reconcile"]);
    second.release();
    await second.finished;
  } finally {
    if (originalNavigator) Object.defineProperty(global, "navigator", originalNavigator);
    else delete global.navigator;
  }
});
