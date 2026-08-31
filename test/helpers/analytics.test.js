const assert = require("node:assert/strict");
const test = require("node:test");
const {
  calculateStreaks,
  countSpokenWords,
  resolveAnalyticsMode,
  summarizeAnalyticsDays,
} = require("../../src/helpers/analytics.js");

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
  assert.equal(
    resolveAnalyticsMode(
      { transcriptionMode: "enterprise", cloudTranscriptionMode: "openwhispr" },
      "azure"
    ),
    "enterprise"
  );
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
