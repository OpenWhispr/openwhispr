const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/utils/dateFormatting.ts");

const t = (key) =>
  ({
    "controlPanel.history.dateGroups.today": "Today",
    "controlPanel.history.dateGroups.yesterday": "Yesterday",
  })[key] || key;

// Local-time constructors keep these assertions timezone-independent.
const NOON_JUNE_15 = new Date(2024, 5, 15, 12, 0, 0).getTime();

test("SQLite timestamps without a zone are treated as UTC", async () => {
  const { normalizeDbDate } = await load();

  const result = normalizeDbDate("2024-01-15 10:30:00");
  assert.ok(result instanceof Date);
  assert.ok(result.toISOString().startsWith("2024-01-15T10:30:00"));

  const alreadyUtc = normalizeDbDate("2024-01-15T10:30:00Z");
  assert.equal(alreadyUtc.toISOString(), "2024-01-15T10:30:00.000Z");
});

test("database timestamps with an explicit numeric offset keep that offset", async () => {
  const { normalizeDbDate } = await load();

  assert.equal(
    normalizeDbDate("2024-01-15T10:30:00+02:00").toISOString(),
    "2024-01-15T08:30:00.000Z"
  );
});

test("history groups label today's and yesterday's dates by calendar day", async (t2) => {
  const { formatDateGroup } = await load();
  t2.mock.timers.enable({ apis: ["Date"], now: NOON_JUNE_15 });

  assert.equal(formatDateGroup(new Date(2024, 5, 15, 8), t), "Today");
  assert.equal(formatDateGroup(new Date(2024, 5, 14, 20), t), "Yesterday");
});

test("history groups fall back to a formatted date for older days", async (t2) => {
  const { formatDateGroup } = await load();
  t2.mock.timers.enable({ apis: ["Date"], now: NOON_JUNE_15 });

  const result = formatDateGroup(new Date(2024, 0, 10, 12), t);
  assert.ok(result);
  assert.notEqual(result, "Today");
  assert.notEqual(result, "Yesterday");
});

test("string dates are accepted", async (t2) => {
  const { formatDateGroup } = await load();
  t2.mock.timers.enable({ apis: ["Date"], now: NOON_JUNE_15 });

  // Serializing the local mocked time gives an explicit-zone string for any host timezone.
  assert.equal(formatDateGroup(new Date(NOON_JUNE_15).toISOString(), t), "Today");
});

test("date-only event starts parse as the local calendar day, not UTC midnight", async () => {
  const { parseEventDate } = await load();
  const previousTimezone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";

  try {
    // A UTC-midnight parse would land on June 14 in Los Angeles.
    const parsed = parseEventDate("2024-06-15");
    assert.equal(parsed.getFullYear(), 2024);
    assert.equal(parsed.getMonth(), 5);
    assert.equal(parsed.getDate(), 15);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("timed event starts keep their instant and invalid values return null", async () => {
  const { parseEventDate } = await load();

  assert.equal(
    parseEventDate("2024-06-15T10:00:00-07:00").getTime(),
    Date.parse("2024-06-15T10:00:00-07:00")
  );
  assert.equal(parseEventDate("not-a-date"), null);
  assert.equal(parseEventDate(""), null);
  assert.equal(parseEventDate(null), null);
});

test("history groups zone-less SQLite timestamps as UTC near a local day boundary", async (t2) => {
  const { formatDateGroup } = await load();
  const previousTimezone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";

  try {
    t2.mock.timers.enable({ apis: ["Date"], now: new Date("2024-06-15T01:00:00Z") });

    // 00:30 UTC is 17:30 on June 14 in Los Angeles, thirty minutes before now.
    assert.equal(formatDateGroup("2024-06-15 00:30:00", t), "Today");
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("normalizeDbDate returns Invalid Date for nullish, non-string, or empty input", async () => {
  const { normalizeDbDate } = await load();
  assert.ok(Number.isNaN(normalizeDbDate(null).getTime()));
  assert.ok(Number.isNaN(normalizeDbDate(undefined).getTime()));
  assert.ok(Number.isNaN(normalizeDbDate("").getTime()));
  assert.ok(Number.isNaN(normalizeDbDate("   ").getTime()));
  assert.ok(Number.isNaN(normalizeDbDate(123).getTime()));
});

test("formatDateGroup returns empty string for nullish or invalid date input", async () => {
  const { formatDateGroup } = await load();
  assert.equal(formatDateGroup(null, t), "");
  assert.equal(formatDateGroup(undefined, t), "");
  assert.equal(formatDateGroup("", t), "");
  assert.equal(formatDateGroup("   ", t), "");
  assert.equal(formatDateGroup("not-a-date", t), "");
  assert.equal(formatDateGroup(new Date(NaN), t), "");
});

test("formatShortDate and formatRelativeTime return empty string for nullish or invalid input", async () => {
  const { formatShortDate, formatRelativeTime } = await load();
  assert.equal(formatShortDate(null), "");
  assert.equal(formatShortDate(undefined), "");
  assert.equal(formatShortDate(""), "");
  assert.equal(formatShortDate("invalid"), "");

  assert.equal(formatRelativeTime(null, t), "");
  assert.equal(formatRelativeTime(undefined, t), "");
  assert.equal(formatRelativeTime("", t), "");
  assert.equal(formatRelativeTime("invalid", t), "");
});
