const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CALENDAR_LOOKBACK_DAYS,
  CALENDAR_LOOKBACK_MS,
} = require("../../src/helpers/calendarCacheWindow.js");
const { MAX_BUFFER_MINUTES } = require("../../src/helpers/calendarAvailability.js");

test("the stored lookback never shrinks availability coverage", () => {
  assert.equal(CALENDAR_LOOKBACK_DAYS, 3);
  // The widest lookback before this window: Google's buffer plus all-day padding.
  assert.ok(CALENDAR_LOOKBACK_MS >= MAX_BUFFER_MINUTES * 60_000 + 48 * 3_600_000);
});
