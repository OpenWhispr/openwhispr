const assert = require("node:assert/strict");
const test = require("node:test");
const {
  calculateStreaks,
  countSpokenWords,
  resolveAnalyticsMode,
  summarizeAnalyticsEvents,
} = require("../../src/helpers/analytics.js");

test("analytics counts raw whitespace-delimited spoken words", () => {
  assert.equal(countSpokenWords("  one two\nthree  "), 3);
  assert.equal(countSpokenWords(""), 0);
});

test("analytics resolves local, cloud, and BYOK modes", () => {
  assert.equal(resolveAnalyticsMode({ useLocalWhisper: true }), "local");
  assert.equal(
    resolveAnalyticsMode({ transcriptionMode: "openwhispr", cloudTranscriptionMode: "openwhispr" }),
    "openwhispr_cloud"
  );
  assert.equal(resolveAnalyticsMode({ transcriptionMode: "providers" }), "byok");
  assert.equal(
    resolveAnalyticsMode({ transcriptionMode: "enterprise", cloudTranscriptionMode: "openwhispr" }),
    "enterprise"
  );
});

test("analytics computes weighted WPM, coverage, and streaks", () => {
  const summary = summarizeAnalyticsEvents(
    [
      { local_date: "2026-08-28", word_count: 100, spoken_duration_ms: 60_000 },
      { local_date: "2026-08-29", word_count: 50, spoken_duration_ms: null },
      { local_date: "2026-08-30", word_count: 100, spoken_duration_ms: 30_000 },
    ],
    "2026-08-30"
  );
  assert.equal(summary.averageWpm, 133);
  assert.equal(summary.wpmCoveragePercent, 80);
  assert.equal(summary.currentStreakDays, 3);
  assert.equal(summary.longestStreakDays, 3);
});

test("analytics expires a stale current streak", () => {
  assert.deepEqual(calculateStreaks(["2026-08-27", "2026-08-28"], "2026-08-30"), {
    currentStreakDays: 0,
    longestStreakDays: 2,
  });
});
