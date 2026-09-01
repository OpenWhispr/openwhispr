const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ANALYTICS_ACTIVITY_MONTH_COUNT,
  buildAnalyticsActivityDays,
  calculateStreaks,
  countSpokenWords,
  resolveAnalyticsMode,
  summarizeAnalyticsDays,
} = require("../../src/helpers/analytics.js");

test("analytics activity covers this month and the previous five calendar months", () => {
  const days = buildAnalyticsActivityDays(
    [
      { date: "2026-03-31", words: 99 },
      { date: "2026-04-01", words: 3 },
      { date: "2026-09-15", words: 7 },
    ],
    new Date(2026, 8, 15, 12)
  );

  assert.equal(ANALYTICS_ACTIVITY_MONTH_COUNT, 6);
  assert.deepEqual(days[0], { date: "2026-04-01", words: 3 });
  assert.deepEqual(days.at(-1), { date: "2026-09-15", words: 7 });
  assert.deepEqual(
    [...new Set(days.map((day) => day.date.slice(0, 7)))],
    ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]
  );
});

test("analytics counts raw whitespace-delimited spoken words", () => {
  assert.equal(countSpokenWords("  one two\nthree  "), 3);
  assert.equal(countSpokenWords(""), 0);
});

test("analytics resolves local, cloud, and BYOK modes", () => {
  assert.equal(resolveAnalyticsMode({ useLocalWhisper: true }, "local-whisper"), "local");
  assert.equal(
    resolveAnalyticsMode(
      { transcriptionMode: "openwhispr", cloudTranscriptionMode: "openwhispr" },
      "openwhispr"
    ),
    "openwhispr_cloud"
  );
  assert.equal(resolveAnalyticsMode({ transcriptionMode: "providers" }, "openai"), "byok");
});

test("analytics credits a fallback to the provider that actually ran", () => {
  // Local whisper failed and the user's OpenAI key transcribed instead.
  assert.equal(resolveAnalyticsMode({ useLocalWhisper: true }, "openai-fallback"), "byok");
  // A streaming provider name cannot tell BYOK from OpenWhispr Cloud, so the
  // selected settings still decide.
  assert.equal(
    resolveAnalyticsMode(
      { transcriptionMode: "openwhispr", cloudTranscriptionMode: "openwhispr" },
      "deepgram-streaming"
    ),
    "openwhispr_cloud"
  );
});

test("analytics computes weighted WPM, coverage, and streaks from day totals", () => {
  const summary = summarizeAnalyticsDays(
    [
      {
        date: "2026-08-30",
        words: 100,
        dictations: 2,
        spokenDurationMs: 30_000,
        coveredWords: 100,
      },
      {
        date: "2026-08-28",
        words: 100,
        dictations: 1,
        spokenDurationMs: 60_000,
        coveredWords: 100,
      },
      { date: "2026-08-29", words: 50, dictations: 1, spokenDurationMs: 0, coveredWords: 0 },
    ],
    "2026-08-30"
  );
  assert.equal(summary.totalWords, 250);
  assert.equal(summary.totalDictations, 4);
  assert.equal(summary.averageWpm, 133);
  assert.equal(summary.wpmCoveragePercent, 80);
  assert.equal(summary.currentStreakDays, 3);
  assert.equal(summary.longestStreakDays, 3);
  // Unsorted input still yields ascending buckets carrying only view fields.
  assert.deepEqual(
    summary.daily.map((bucket) => bucket.date),
    ["2026-08-28", "2026-08-29", "2026-08-30"]
  );
  assert.deepEqual(Object.keys(summary.daily[0]).sort(), [
    "date",
    "dictations",
    "spokenDurationMs",
    "words",
  ]);
});

test("analytics expires a stale current streak", () => {
  assert.deepEqual(calculateStreaks(["2026-08-27", "2026-08-28"], "2026-08-30"), {
    currentStreakDays: 0,
    longestStreakDays: 2,
  });
});
