const test = require("node:test");
const assert = require("node:assert/strict");

const loadDemo = () => import("../../src/helpers/leaderboardDemo.ts");

test("leaderboard demo is available only for an explicitly enabled development build", async () => {
  const { isLeaderboardDemoEnvironment } = await loadDemo();
  assert.equal(isLeaderboardDemoEnvironment({ DEV: true, VITE_LEADERBOARD_DEMO: "true" }), true);
  assert.equal(isLeaderboardDemoEnvironment({ DEV: false, VITE_LEADERBOARD_DEMO: "true" }), false);
  assert.equal(isLeaderboardDemoEnvironment({ DEV: true, VITE_LEADERBOARD_DEMO: "false" }), false);
});
