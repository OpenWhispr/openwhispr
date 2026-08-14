const test = require("node:test");
const assert = require("node:assert/strict");

const load = async () => {
  const m = await import("../../src/utils/formatDuration.ts");
  return m.default || m;
};

test("formatMmSs formats valid positive seconds", async () => {
  const { formatMmSs } = await load();
  assert.equal(formatMmSs(0), "00:00");
  assert.equal(formatMmSs(5), "00:05");
  assert.equal(formatMmSs(65), "01:05");
  assert.equal(formatMmSs(3605), "60:05");
});

test("formatMmSs handles sub-zero, non-finite, NaN, and nullish inputs safely", async () => {
  const { formatMmSs } = await load();
  assert.equal(formatMmSs(-5), "00:00");
  assert.equal(formatMmSs(NaN), "00:00");
  assert.equal(formatMmSs(Infinity), "00:00");
  assert.equal(formatMmSs(-Infinity), "00:00");
  assert.equal(formatMmSs(null), "00:00");
  assert.equal(formatMmSs(undefined), "00:00");
});
