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
  assert.equal(storage.getItem("leaderboardLeavePending:user%2Ftwo"), '{"attempts":0}');
});

// Builds before the attempt bound stored a bare "true". Reading one as anything
// but a pending leave would silently put the account back on a leaderboard.
test("a leave recorded by an older build still counts and can still be charged", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: { "leaderboardLeavePending:user%2Fold": "true" },
  });
  const {
    pendingLeaderboardLeaveDeservesPriority,
    readPendingLeaderboardLeave,
    recordPendingLeaderboardLeaveAttempt,
    MAX_PRIORITY_LEAVE_ATTEMPTS,
  } = require("../../src/lib/pendingLeaderboardLeave.ts");

  assert.equal(readPendingLeaderboardLeave("user/old"), true);
  assert.equal(pendingLeaderboardLeaveDeservesPriority("user/old"), true);

  for (let attempt = 0; attempt < MAX_PRIORITY_LEAVE_ATTEMPTS; attempt += 1) {
    recordPendingLeaderboardLeaveAttempt("user/old");
  }

  assert.equal(pendingLeaderboardLeaveDeservesPriority("user/old"), false);
  assert.equal(readPendingLeaderboardLeave("user/old"), true);
});

test("an account with no pending leave is never charged an attempt", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const {
    pendingLeaderboardLeaveDeservesPriority,
    readPendingLeaderboardLeave,
    recordPendingLeaderboardLeaveAttempt,
  } = require("../../src/lib/pendingLeaderboardLeave.ts");

  recordPendingLeaderboardLeaveAttempt("user/none");

  assert.equal(storage.getItem("leaderboardLeavePending:user%2Fnone"), null);
  assert.equal(readPendingLeaderboardLeave("user/none"), false);
  assert.equal(pendingLeaderboardLeaveDeservesPriority("user/none"), false);
});
