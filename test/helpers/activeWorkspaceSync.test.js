const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

test("workspace storage events refresh the exact active workspace", async (t) => {
  const listeners = new Map();
  installBrowserGlobals(t, {
    window: {
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      removeEventListener(type) {
        listeners.delete(type);
      },
    },
  });
  const { installActiveWorkspaceSync } = await import(
    "../../src/stores/activeWorkspaceSync.ts"
  );
  const refreshed = [];
  const remove = installActiveWorkspaceSync((workspaceId) => refreshed.push(workspaceId));

  listeners.get("storage")({ key: "activeWorkspaceId", newValue: "workspace-b" });
  listeners.get("storage")({ key: "other", newValue: "workspace-c" });
  remove();

  assert.deepEqual(refreshed, ["workspace-b"]);
});
