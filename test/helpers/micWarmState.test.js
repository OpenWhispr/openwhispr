const test = require("node:test");
const assert = require("node:assert/strict");

const { isMicWarm, MIC_WARM_TTL_MS } = require("../../src/helpers/micWarmState");

test("MIC_WARM_TTL_MS is 5000", () => {
  assert.equal(MIC_WARM_TTL_MS, 5000);
});

test("is not warm for a zero timestamp", () => {
  assert.equal(isMicWarm(0, 1000), false);
});

test("is not warm for a missing timestamp", () => {
  assert.equal(isMicWarm(undefined, 1000), false);
  assert.equal(isMicWarm(null, 1000), false);
});

test("is not warm for a non-number timestamp", () => {
  assert.equal(isMicWarm("1000", 2000), false);
  assert.equal(isMicWarm(NaN, 2000), false);
});

test("is warm when the elapsed time is below the TTL", () => {
  assert.equal(isMicWarm(1000, 1000 + MIC_WARM_TTL_MS - 1), true);
  // Zero elapsed still counts as warm.
  assert.equal(isMicWarm(1000, 1000), true);
});

test("is not warm at exactly the TTL", () => {
  assert.equal(isMicWarm(1000, 1000 + MIC_WARM_TTL_MS), false);
});

test("is not warm beyond the TTL", () => {
  assert.equal(isMicWarm(1000, 1000 + MIC_WARM_TTL_MS + 1), false);
});

test("is not warm when the clock jumped backwards", () => {
  assert.equal(isMicWarm(5000, 4000), false);
});

test("honors a custom ttlMs argument", () => {
  assert.equal(isMicWarm(1000, 1500, 1000), true);
  // Exactly the custom TTL is not warm.
  assert.equal(isMicWarm(1000, 2000, 1000), false);
  assert.equal(isMicWarm(1000, 2001, 1000), false);
});
