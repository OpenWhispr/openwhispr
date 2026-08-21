const test = require("node:test");
const assert = require("node:assert/strict");

function createEventTarget() {
  const listeners = new Set();
  return {
    addEventListener(type, listener) {
      if (type === "storage") listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === "storage") listeners.delete(listener);
    },
    dispatchStorage(event) {
      for (const listener of listeners) listener(event);
    },
  };
}

test("the reconciliation owner follows another renderer's workspace switch exactly once", async () => {
  const { subscribeToActiveWorkspaceStorageChanges, ACTIVE_WORKSPACE_KEY } =
    await import("../../src/stores/activeWorkspaceSync.ts");
  const ownerWindow = createEventTarget();
  const sharedStorage = {};
  let ownerWorkspaceId = "workspace-a";
  const reconciled = [];
  const unsubscribe = subscribeToActiveWorkspaceStorageChanges(
    ownerWindow,
    sharedStorage,
    () => ownerWorkspaceId,
    (workspaceId) => {
      ownerWorkspaceId = workspaceId;
      reconciled.push(workspaceId);
    }
  );

  const switchFromControlPanel = {
    key: ACTIVE_WORKSPACE_KEY,
    newValue: "workspace-b",
    storageArea: sharedStorage,
  };
  ownerWindow.dispatchStorage(switchFromControlPanel);
  ownerWindow.dispatchStorage(switchFromControlPanel);

  assert.equal(ownerWorkspaceId, "workspace-b");
  assert.deepEqual(reconciled, ["workspace-b"]);
  unsubscribe();
});
