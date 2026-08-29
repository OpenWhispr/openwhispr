const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/utils/dateGrouping.ts");

const t = (key) =>
  ({
    "chat.today": "Today",
    "chat.yesterday": "Yesterday",
    "chat.previousWeek": "Previous 7 days",
    "chat.older": "Older",
  })[key] || key;

const NOON_JUNE_15 = new Date(2024, 5, 15, 12, 0, 0).getTime();

function localIsoDate(year, month, day, hour) {
  return new Date(year, month, day, hour).toISOString();
}

function utcDbDate(year, month, day, hour) {
  // normalizeDbDate treats zoneless SQLite timestamps as UTC, so emit UTC.
  return new Date(Date.UTC(year, month, day, hour)).toISOString().replace("T", " ").slice(0, 19);
}

test("groups newest-first items into calendar buckets in order", async (t2) => {
  const { groupItemsByDate } = await load();
  t2.mock.timers.enable({ apis: ["Date"], now: NOON_JUNE_15 });

  const items = [
    { id: 1, updated_at: localIsoDate(2024, 5, 15, 10) },
    { id: 2, updated_at: localIsoDate(2024, 5, 15, 8) },
    { id: 3, updated_at: localIsoDate(2024, 5, 14, 22) },
    { id: 4, updated_at: localIsoDate(2024, 5, 10, 12) },
    { id: 5, updated_at: localIsoDate(2024, 0, 1, 12) },
  ];
  const groups = groupItemsByDate(items, (i) => i.updated_at, t);

  assert.deepEqual(
    groups.map((g) => g.label),
    ["Today", "Yesterday", "Previous 7 days", "Older"]
  );
  assert.deepEqual(
    groups.map((g) => g.items.map((i) => i.id)),
    [[1, 2], [3], [4], [5]]
  );
});

test("boundary days land in the nearest bucket", async (t2) => {
  const { groupItemsByDate } = await load();
  t2.mock.timers.enable({ apis: ["Date"], now: NOON_JUNE_15 });

  const items = [
    // Exactly 7 days back is still "Previous 7 days"; 8 days back is "Older".
    { id: 1, updated_at: localIsoDate(2024, 5, 8, 12) },
    { id: 2, updated_at: localIsoDate(2024, 5, 7, 12) },
  ];
  const groups = groupItemsByDate(items, (i) => i.updated_at, t);
  assert.deepEqual(
    groups.map((g) => g.label),
    ["Previous 7 days", "Older"]
  );
});

test("empty input yields no groups", async () => {
  const { groupItemsByDate } = await load();
  assert.deepEqual(groupItemsByDate([], () => "", t), []);
});

test("SQLite zoneless timestamps are grouped like their UTC instant", async (t2) => {
  const { groupItemsByDate } = await load();
  t2.mock.timers.enable({ apis: ["Date"], now: NOON_JUNE_15 });

  const utcNow = new Date();
  const todayDb = utcDbDate(
    utcNow.getUTCFullYear(),
    utcNow.getUTCMonth(),
    utcNow.getUTCDate(),
    utcNow.getUTCHours()
  );
  const groups = groupItemsByDate([{ updated_at: todayDb }], (i) => i.updated_at, t);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "Today");
});
