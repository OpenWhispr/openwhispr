const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MATCH_THRESHOLD,
  MATCH_MARGIN,
  CONFIDENT_MATCH_THRESHOLD,
  acceptsMatch,
} = require("../../src/helpers/liveSpeakerMatching.js");

// The runner-up matters only when it is close enough to be a genuinely
// different candidate. Two clusters that BOTH strongly match the same voice are
// evidence they are duplicates of one person, not evidence of ambiguity —
// treating that as ambiguous is what made a 3-person call report 10+ speakers.

test("a clear match against a single cluster is accepted", () => {
  assert.equal(acceptsMatch(0.88, 0.42), true);
});

test("a confident match is accepted even when a duplicate cluster ties it", () => {
  // Real regression: one person with two clusters. Both score high for their
  // own voice, so the top-two gap collapses below MATCH_MARGIN.
  assert.equal(acceptsMatch(0.88, 0.86), true, "0.02 gap but both are clearly the same voice");
  assert.equal(acceptsMatch(0.88, 0.87), true);
  assert.equal(acceptsMatch(0.85, 0.845), true);
});

test("the runaway is closed: repeated near-ties never force a new speaker", () => {
  // Each row is what the matcher sees as duplicates accumulate for one voice.
  const rounds = [
    [0.88, 0.42],
    [0.88, 0.86],
    [0.88, 0.87],
    [0.89, 0.885],
  ];
  for (const [best, second] of rounds) {
    assert.equal(
      acceptsMatch(best, second),
      true,
      `best=${best} second=${second} must match an existing speaker, not mint a new one`
    );
  }
});

test("an ambiguous match between two distinct speakers is still rejected", () => {
  // Both are only weakly similar and nearly tied — genuinely ambiguous, so the
  // margin rule still applies and we would rather create a new speaker.
  assert.equal(acceptsMatch(0.7, 0.69), false);
  assert.equal(acceptsMatch(0.72, 0.7), false);
});

test("a weak best match is rejected regardless of the gap", () => {
  assert.equal(acceptsMatch(0.5, 0.1), false, "below MATCH_THRESHOLD is never a match");
  assert.equal(acceptsMatch(0.64, 0.0), false);
});

test("a match at exactly the threshold with a clear gap is accepted", () => {
  assert.equal(acceptsMatch(MATCH_THRESHOLD, MATCH_THRESHOLD - MATCH_MARGIN), true);
});

test("no candidates at all is not a match", () => {
  assert.equal(acceptsMatch(-Infinity, -Infinity), false);
  assert.equal(acceptsMatch(0, 0), false);
});

test("the confident threshold sits above the match threshold", () => {
  assert.ok(
    CONFIDENT_MATCH_THRESHOLD > MATCH_THRESHOLD,
    "a confident match must be strictly stronger than a bare match"
  );
  assert.ok(CONFIDENT_MATCH_THRESHOLD < 1);
});
