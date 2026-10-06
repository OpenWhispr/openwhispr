const test = require("node:test");
const assert = require("node:assert/strict");
const {
  decodeLeaderboardPngDataUrl,
  leaderboardImageFilename,
} = require("../../src/helpers/leaderboardImage");

const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test("leaderboard image IPC accepts bounded PNG data only", () => {
  const decoded = decodeLeaderboardPngDataUrl(
    `data:image/png;base64,${PNG_HEADER.toString("base64")}`
  );
  assert.deepEqual(decoded, PNG_HEADER);
  assert.throws(() => decodeLeaderboardPngDataUrl("data:text/plain;base64,SGVsbG8="), /PNG/);
  assert.throws(() => decodeLeaderboardPngDataUrl("data:image/png;base64,%%%%"), /base64/);
});

test("leaderboard downloads cannot inject paths through the suggested name", () => {
  assert.equal(leaderboardImageFilename("Acme leaderboard"), "Acme-leaderboard.png");
  assert.equal(leaderboardImageFilename("../../secret.txt"), "..-..-secret.txt.png");
  assert.equal(leaderboardImageFilename("team.png"), "team.png");
});
