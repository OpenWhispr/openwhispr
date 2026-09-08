const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("./rendererTestHarness");

test("different accounts keep independent durable leaderboard leaves", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const {
    clearPendingLeaderboardLeave,
    readPendingLeaderboardLeave,
    writePendingLeaderboardLeave,
  } = require("../../src/lib/pendingLeaderboardLeave.ts");

  writePendingLeaderboardLeave("user/one");
  writePendingLeaderboardLeave("user/two");
  clearPendingLeaderboardLeave("user/one");

  assert.equal(readPendingLeaderboardLeave("user/one"), false);
  assert.equal(readPendingLeaderboardLeave("user/two"), true);
  assert.equal(storage.getItem("leaderboardLeavePending:user%2Ftwo"), "true");
});
