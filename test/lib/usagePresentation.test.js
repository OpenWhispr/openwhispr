const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getUsagePercentage,
  getUsageReturnCountdown,
} = require("../../src/lib/usagePresentation.ts");

test("weekly percentage handles empty, partial, exact, and exceeded allowances", () => {
  assert.equal(getUsagePercentage(0, 2000), 0);
  assert.equal(getUsagePercentage(860, 2000), 43);
  for (const [wordsUsed, percentage] of [
    [580, 29],
    [1140, 57],
    [1160, 58],
  ]) {
    assert.equal(getUsagePercentage(wordsUsed, 2000), percentage);
  }
  assert.equal(getUsagePercentage(1999, 2000), 99.95);
  assert.equal(getUsagePercentage(2000, 2000), 100);
  assert.equal(getUsagePercentage(2300, 2000), 100);
  for (const limit of [0, -1]) {
    assert.equal(getUsagePercentage(860, limit), null);
  }
});

test("countdown selects days, hours, and minutes without promising early availability", () => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  for (const [seconds, unit, count] of [
    [172800, "day", 2],
    [86401, "day", 2],
    [86400, "day", 1],
    [86399, "hour", 24],
    [3600, "hour", 1],
    [3599, "minute", 60],
    [60, "minute", 1],
    [1, "minute", 1],
  ]) {
    assert.deepEqual(getUsageReturnCountdown(now + seconds * 1000, now), { unit, count });
  }
});

test("missing and elapsed return times have no countdown", () => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  for (const availableAt of [null, now, now - 86_400_000]) {
    assert.equal(getUsageReturnCountdown(availableAt, now), null);
  }
});
