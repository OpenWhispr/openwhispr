const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/dateFormatting.ts");

test("future timestamps use a calendar date instead of the now label", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-21T12:00:00.000Z") });
  const { formatRelativeTime, formatShortDate } = await load();
  const futureTimestamp = "2026-08-21T14:00:00.000Z";

  assert.equal(
    formatRelativeTime(futureTimestamp, (key) => key),
    formatShortDate(futureTimestamp)
  );
});
