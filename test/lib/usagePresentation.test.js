const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getUsagePercentage,
  getUsageReturnCountdown,
} = require("../../src/lib/usagePresentation.ts");

test("weekly percentage handles empty, partial, exact, and exceeded allowances", () => {
  assert.equal(getUsagePercentage(0, 2000), 0);
  assert.equal(getUsagePercentage(860, 2000), 43);
  assert.equal(getUsagePercentage(1999, 2000), 99.95);
  assert.equal(getUsagePercentage(2000, 2000), 100);
  assert.equal(getUsagePercentage(2300, 2000), 100);
  assert.equal(getUsagePercentage(-1, 2000), 0);
  for (const limit of [0, -1, NaN, Infinity]) {
    assert.equal(getUsagePercentage(860, limit), null);
  }
  assert.equal(getUsagePercentage(NaN, 2000), null);
});

test("countdown selects days, hours, and minutes without promising early availability", () => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  const at = (seconds) => new Date(now + seconds * 1000).toISOString();
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
    assert.deepEqual(getUsageReturnCountdown(at(seconds), now), { unit, count });
  }
});

test("legacy, missing, malformed, and elapsed timestamps have no countdown", () => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  for (const value of [null, "", "rolling", "invalid", new Date(now).toISOString()]) {
    assert.equal(getUsageReturnCountdown(value, now), null);
  }
  assert.equal(getUsageReturnCountdown("2026-09-20T12:00:00Z", now), null);
});
