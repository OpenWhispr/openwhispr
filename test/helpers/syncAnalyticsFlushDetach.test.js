const test = require("node:test");
const assert = require("node:assert/strict");

const {
  installBrowserGlobals,
  resetBrowserGlobals,
  enableSync,
  establishValidatedAuth,
  stopSyncTimers,
  window: windowStub,
} = require("./harness/browserGlobals.js");
const { SyncService } = require("../../src/services/SyncService.ts");
const { LeaderboardService } = require("../../src/services/LeaderboardService.ts");

// syncAnalytics runs under SYNC_ALL_LOCK, and a cloud request carries no
// timeout. Awaiting the pending-leave retry there let one hung PATCH hold every
// window's sync behind the lock for as long as the socket stayed open.
test("a hung leaderboard leave retry does not hold the analytics pass", async (t) => {
  resetBrowserGlobals();
  installBrowserGlobals();
  enableSync();
  // Just enough bridge to validate a session. There are no analytics rows and
  // no upload path, which is exactly the pass that used to sit behind the retry.
  windowStub.electronAPI = {
    authGetTokenState: async () => ({ token: "harness-token", generation: 1 }),
  };
  await establishValidatedAuth();
  const service = new SyncService();
  t.after(() => stopSyncTimers(service));
  t.mock.method(console, "error", () => {});

  let retries = 0;
  t.mock.method(LeaderboardService, "flushPendingLeave", () => {
    retries += 1;
    return new Promise(() => {});
  });

  const outcome = await Promise.race([
    service.syncAnalyticsNow().then(
      () => "settled",
      () => "settled"
    ),
    new Promise((resolve) => setTimeout(() => resolve("held"), 1_000)),
  ]);

  assert.equal(retries, 1, "the retry is still issued on every pass");
  assert.equal(outcome, "settled", "the pass may not wait on a request that never answers");
});
