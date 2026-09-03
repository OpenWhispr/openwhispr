const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (relativePath) => fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");

test("the leaderboard is a standalone control-panel view", () => {
  const controlPanel = read("src/components/ControlPanel.tsx");
  const sidebar = read("src/components/ControlPanelSidebar.tsx");
  const insights = read("src/components/InsightsView.tsx");
  const leaderboard = read("src/components/LeaderboardView.tsx");

  assert.ok(sidebar.includes('| "leaderboard"'));
  assert.ok(sidebar.includes('{ id: "leaderboard"'));
  assert.ok(controlPanel.includes('activeView === "leaderboard"'));
  assert.ok(controlPanel.includes("<LeaderboardView"));
  assert.equal(insights.includes("LeaderboardSection"), false);
  assert.ok(leaderboard.includes("<LeaderboardSection"));
  assert.ok(leaderboard.includes('<h1 className="text-base!'));
  assert.ok(leaderboard.includes('t("insights.leaderboard.title")'));
});

test("the production control panel has no leaderboard demo path", () => {
  const controlPanel = read("src/components/ControlPanel.tsx");
  const leaderboard = read("src/components/LeaderboardView.tsx");

  assert.equal(controlPanel.includes("LEADERBOARD_DEMO_ENABLED"), false);
  assert.equal(leaderboard.includes("LEADERBOARD_DEMO_ENABLED"), false);
  assert.ok(controlPanel.includes('useState<ControlPanelView>("home")'));
});
