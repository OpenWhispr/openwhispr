const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/dateFormatting.ts");

test("future timestamps use a calendar date instead of the now label", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-08-21T12:00:00.000Z") });
  const { formatRelativeTime } = await load();

  assert.notEqual(
    formatRelativeTime("2026-08-21T14:00:00.000Z", (key) => key),
    "notes.list.timeNow"
  );
});
