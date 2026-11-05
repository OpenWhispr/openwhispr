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

test("formatEventWhen labels all-day events and shows a time range otherwise", async () => {
  const { formatEventWhen, formatTimeRange } = await load();
  assert.equal(
    formatEventWhen(
      { start_time: "2026-10-20", end_time: "2026-10-21", is_all_day: 1 },
      "en-US",
      "All day"
    ),
    "Tue, Oct 20 · All day"
  );

  const start = new Date(2026, 9, 20, 14, 15).toISOString();
  const end = new Date(2026, 9, 20, 15, 15).toISOString();
  assert.equal(
    formatEventWhen({ start_time: start, end_time: end, is_all_day: 0 }, "en-US", "All day"),
    `Tue, Oct 20 · ${formatTimeRange("en-US", start, end)}`
  );
});
