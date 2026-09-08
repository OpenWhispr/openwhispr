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
  assert.equal(storage.getItem("leaderboardLeavePendingUserIds"), null);
});

test("a cleared legacy leave stays cleared without rewriting the shared array", async (t) => {
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { leaderboardLeavePendingUserIds: '["user_1","user_2"]' },
  });
  const {
    clearPendingLeaderboardLeave,
    readPendingLeaderboardLeave,
  } = require("../../src/lib/pendingLeaderboardLeave.ts");

  assert.equal(readPendingLeaderboardLeave("user_1"), true);
  clearPendingLeaderboardLeave("user_1");

  assert.equal(readPendingLeaderboardLeave("user_1"), false);
  assert.equal(readPendingLeaderboardLeave("user_2"), true);
  assert.equal(storage.getItem("leaderboardLeavePendingUserIds"), '["user_1","user_2"]');
  assert.equal(storage.getItem("leaderboardLeaveResolved:user_1"), "true");
});
