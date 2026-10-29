// Sign-out can happen offline, before the auth reconcile that resets the workspace store, so
// the sign-out cleanup itself must drop the cached workspace list (Stripe ids, owner names).

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  installBrowserGlobals,
  resetBrowserGlobals,
  stopSyncTimers,
  localStorage: browserLocalStorage,
} = require("../helpers/harness/browserGlobals.js");

installBrowserGlobals();

test("sign-out cleanup removes the cached workspace list and the active workspace", async (t) => {
  resetBrowserGlobals();
  const { SyncService } = await import("../../src/services/SyncService.ts");
  const { WORKSPACE_LIST_CACHE_KEY } = await import("../../src/stores/workspaceStore.ts");
  browserLocalStorage.setItem(
    WORKSPACE_LIST_CACHE_KEY,
    JSON.stringify({ accountId: "acct-1", fetchedAt: Date.now(), workspaces: [{ id: "ws-1" }] })
  );
  browserLocalStorage.setItem("activeWorkspaceId", "ws-1");
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));

  await service.purgeTeamSpacesForSignOut();

  assert.equal(browserLocalStorage.getItem(WORKSPACE_LIST_CACHE_KEY), null);
  assert.equal(browserLocalStorage.getItem("activeWorkspaceId"), null);
});
