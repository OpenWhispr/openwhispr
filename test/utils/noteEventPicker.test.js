const test = require("node:test");
const assert = require("node:assert/strict");

// A zone with daylight saving, so local-day boundaries differ from UTC ones
// even on CI (TZ=UTC). Each test file runs in its own process.
process.env.TZ = "America/Los_Angeles";

const load = () => import("../../src/utils/noteEventPicker.ts");

const iso = (...parts) => new Date(...parts).toISOString();

function event(id, start, end, overrides = {}) {
  return {
    id,
    calendar_id: "cal",
    provider: "google",
    summary: id,
    start_time: start,
    end_time: end,
    is_all_day: 0,
    status: "confirmed",
    attendees: null,
    ...overrides,
  };
}

test("eventsOnDay keeps every event that overlaps the local day, all-day ones first", async () => {
  const { eventsOnDay } = await load();
  const events = [
    event("overnight-in", iso(2026, 9, 19, 23), iso(2026, 9, 20, 1)),
    event("morning", iso(2026, 9, 20, 10), iso(2026, 9, 20, 13)),
    event("late", iso(2026, 9, 20, 23, 30), iso(2026, 9, 21, 0, 30)),
    event("all-day", "2026-10-20", "2026-10-21", { is_all_day: 1 }),
    event("conference", "2026-10-19", "2026-10-22", { is_all_day: 1 }),
    event("yesterday-all-day", "2026-10-19", "2026-10-20", { is_all_day: 1 }),
    event("next-all-day", "2026-10-21", "2026-10-22", { is_all_day: 1 }),
    event("yesterday", iso(2026, 9, 19, 8), iso(2026, 9, 19, 9)),
    event("ends-at-midnight", iso(2026, 9, 19, 22), iso(2026, 9, 20, 0)),
  ];

  assert.deepEqual(
    eventsOnDay(events, new Date(2026, 9, 20, 13, 45)).map((e) => e.id),
    ["all-day", "conference", "overnight-in", "morning", "late"]
  );
});

test("eventsOnDay uses calendar midnights on a 25-hour daylight-saving day", async () => {
  const { eventsOnDay } = await load();
  // US daylight saving ends on Sunday Nov 1, 2026: that local day lasts 25 hours.
  const lateEvening = event("late-evening", iso(2026, 10, 1, 23, 30), iso(2026, 10, 1, 23, 45));

  assert.deepEqual(
    eventsOnDay([lateEvening], new Date(2026, 10, 1, 9)).map((e) => e.id),
    ["late-evening"]
  );
  assert.deepEqual(eventsOnDay([lateEvening], new Date(2026, 10, 2, 9)), []);
});

test("searchLinkableEvents matches titles and guests, nearest to the note first", async () => {
  const { searchLinkableEvents } = await load();
  const anchor = new Date(2026, 9, 20, 12);
  const events = [
    event("standup-later", iso(2026, 9, 23, 9), iso(2026, 9, 23, 10), { summary: "Team Standup" }),
    event("standup-yesterday", iso(2026, 9, 19, 9), iso(2026, 9, 19, 10), {
      summary: "Team Standup",
    }),
    event("one-on-one", iso(2026, 9, 19, 9), iso(2026, 9, 19, 10), {
      summary: "1:1",
      attendees: JSON.stringify([{ email: "e.v@x.com", displayName: "Evelyn" }]),
    }),
  ];

  assert.deepEqual(
    searchLinkableEvents(events, " team ", anchor).map((e) => e.id),
    ["standup-yesterday", "standup-later"]
  );
  assert.deepEqual(
    searchLinkableEvents(events, "EVELYN", anchor).map((e) => e.id),
    ["one-on-one"],
    "guest display names are searched"
  );
  assert.deepEqual(
    searchLinkableEvents(events, "e.v@x", anchor).map((e) => e.id),
    ["one-on-one"],
    "guest emails are searched"
  );
  assert.deepEqual(searchLinkableEvents(events, "  ", anchor), []);
});

test("searchLinkableEvents returns the 50 events nearest the note", async () => {
  const { searchLinkableEvents } = await load();
  const anchor = new Date(2026, 9, 20, 12);
  // Input order is oldest first, so a cap applied before sorting would return
  // the 50 furthest from the note.
  const events = Array.from({ length: 80 }, (_, i) =>
    event(`e${i}`, iso(2026, 9, 20, 12 - 80 + i), iso(2026, 9, 20, 13 - 80 + i), {
      summary: "Sync",
    })
  );

  const results = searchLinkableEvents(events, "sync", anchor);
  assert.equal(results.length, 50);
  assert.deepEqual(results.map((e) => e.id).slice(0, 2), ["e79", "e78"]);
  assert.equal(results.at(-1).id, "e30");
});

test("startsBeforeStoredWindow flags any day the stored history doesn't fully cover", async () => {
  const { startsBeforeStoredWindow } = await load();
  // The stored history reaches back to Oct 17 12:00.
  const now = new Date(2026, 9, 20, 12).getTime();

  assert.equal(startsBeforeStoredWindow(new Date(2026, 9, 16, 9), now), true);
  assert.equal(startsBeforeStoredWindow(new Date(2026, 9, 17, 18), now), true);
  assert.equal(startsBeforeStoredWindow(new Date(2026, 9, 18, 9), now), false);
  assert.equal(startsBeforeStoredWindow(new Date(2026, 9, 20, 9), now), false);
});
