const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/availability.ts");

const OPTIONS = { dayStartMinutes: 9 * 60, dayEndMinutes: 18 * 60, minSlotMinutes: 30 };

// Inputs are built from local date components so the expected local wall-clock
// output is identical in every test-runner timezone.
function localIso(y, m, d, h, min) {
  return new Date(y, m - 1, d, h, min).toISOString();
}

function timedEvent(overrides = {}) {
  return {
    id: "e1",
    calendar_id: "cal",
    provider: "google",
    summary: "Standup",
    start_time: localIso(2026, 8, 26, 10, 0),
    end_time: localIso(2026, 8, 26, 10, 30),
    is_all_day: 0,
    status: "confirmed",
    attendees: null,
    ...overrides,
  };
}

test("an empty day is one free slot spanning the whole window", async () => {
  const { computeAvailability } = await load();
  const days = computeAvailability([], "2026-08-26", "2026-08-26", OPTIONS);

  assert.deepEqual(days, [
    {
      date: "2026-08-26",
      free: [{ start: "2026-08-26T09:00", end: "2026-08-26T18:00" }],
      busy: [],
      allDayEvents: [],
    },
  ]);
});

test("busy events split the day into surrounding free slots", async () => {
  const { computeAvailability } = await load();
  const days = computeAvailability(
    [
      timedEvent(),
      timedEvent({
        id: "e2",
        summary: "Design review",
        start_time: localIso(2026, 8, 26, 14, 0),
        end_time: localIso(2026, 8, 26, 15, 0),
        status: "tentative",
      }),
    ],
    "2026-08-26",
    "2026-08-26",
    OPTIONS
  );

  assert.deepEqual(days[0].free, [
    { start: "2026-08-26T09:00", end: "2026-08-26T10:00" },
    { start: "2026-08-26T10:30", end: "2026-08-26T14:00" },
    { start: "2026-08-26T15:00", end: "2026-08-26T18:00" },
  ]);
  assert.deepEqual(days[0].busy, [
    {
      start: "2026-08-26T10:00",
      end: "2026-08-26T10:30",
      summary: "Standup",
      status: "confirmed",
    },
    {
      start: "2026-08-26T14:00",
      end: "2026-08-26T15:00",
      summary: "Design review",
      status: "tentative",
    },
  ]);
});

test("overlapping events do not produce free slots between them", async () => {
  const { computeAvailability } = await load();
  const days = computeAvailability(
    [
      timedEvent({
        start_time: localIso(2026, 8, 26, 10, 0),
        end_time: localIso(2026, 8, 26, 12, 0),
      }),
      timedEvent({
        id: "e2",
        start_time: localIso(2026, 8, 26, 11, 0),
        end_time: localIso(2026, 8, 26, 13, 0),
      }),
    ],
    "2026-08-26",
    "2026-08-26",
    OPTIONS
  );

  assert.deepEqual(days[0].free, [
    { start: "2026-08-26T09:00", end: "2026-08-26T10:00" },
    { start: "2026-08-26T13:00", end: "2026-08-26T18:00" },
  ]);
});

test("gaps shorter than minSlotMinutes are not offered as free", async () => {
  const { computeAvailability } = await load();
  const days = computeAvailability(
    [
      timedEvent({
        start_time: localIso(2026, 8, 26, 9, 0),
        end_time: localIso(2026, 8, 26, 12, 0),
      }),
      timedEvent({
        id: "e2",
        start_time: localIso(2026, 8, 26, 12, 20),
        end_time: localIso(2026, 8, 26, 18, 0),
      }),
    ],
    "2026-08-26",
    "2026-08-26",
    OPTIONS
  );

  assert.deepEqual(days[0].free, []);
});

test("a declined meeting does not hold the user's time", async () => {
  const { computeAvailability } = await load();
  const days = computeAvailability(
    [
      timedEvent({
        attendees: JSON.stringify([
          { email: "gabe@openwhispr.com", displayName: null, responseStatus: "declined", self: true },
          { email: "other@example.com", displayName: null, responseStatus: "accepted", self: false },
        ]),
      }),
    ],
    "2026-08-26",
    "2026-08-26",
    OPTIONS
  );

  assert.deepEqual(days[0].busy, []);
  assert.deepEqual(days[0].free, [{ start: "2026-08-26T09:00", end: "2026-08-26T18:00" }]);
});

test("a meeting someone else declined still holds the user's time", async () => {
  const { computeAvailability } = await load();
  const days = computeAvailability(
    [
      timedEvent({
        attendees: JSON.stringify([
          { email: "other@example.com", displayName: null, responseStatus: "declined", self: false },
        ]),
      }),
    ],
    "2026-08-26",
    "2026-08-26",
    OPTIONS
  );

  assert.equal(days[0].busy.length, 1);
});

test("all-day events are reported per covered day but never subtract free time", async () => {
  const { computeAvailability } = await load();
  // Google all-day rows: bare dates, exclusive end (26th–27th = two days).
  const days = computeAvailability(
    [
      timedEvent({
        summary: "PTO",
        start_time: "2026-08-26",
        end_time: "2026-08-28",
        is_all_day: 1,
      }),
    ],
    "2026-08-26",
    "2026-08-28",
    OPTIONS
  );

  assert.deepEqual(
    days.map((d) => d.allDayEvents.length),
    [1, 1, 0]
  );
  assert.deepEqual(days[0].free, [{ start: "2026-08-26T09:00", end: "2026-08-26T18:00" }]);
});

test("an event spanning midnight is clipped to each day's window", async () => {
  const { computeAvailability } = await load();
  const days = computeAvailability(
    [
      timedEvent({
        summary: "Red-eye flight",
        start_time: localIso(2026, 8, 26, 17, 0),
        end_time: localIso(2026, 8, 27, 10, 0),
      }),
    ],
    "2026-08-26",
    "2026-08-27",
    OPTIONS
  );

  assert.deepEqual(days[0].busy, [
    {
      start: "2026-08-26T17:00",
      end: "2026-08-26T18:00",
      summary: "Red-eye flight",
      status: "confirmed",
    },
  ]);
  assert.deepEqual(days[1].busy, [
    {
      start: "2026-08-27T09:00",
      end: "2026-08-27T10:00",
      summary: "Red-eye flight",
      status: "confirmed",
    },
  ]);
  assert.deepEqual(days[1].free, [{ start: "2026-08-27T10:00", end: "2026-08-27T18:00" }]);
});

test("parseTimeOfDay accepts HH:MM and rejects everything else", async () => {
  const { parseTimeOfDay } = await load();
  assert.equal(parseTimeOfDay("09:00"), 540);
  assert.equal(parseTimeOfDay("9:30"), 570);
  assert.equal(parseTimeOfDay("23:59"), 1439);
  assert.equal(parseTimeOfDay("24:00"), null);
  assert.equal(parseTimeOfDay("12:60"), null);
  assert.equal(parseTimeOfDay("noon"), null);
  assert.equal(parseTimeOfDay(9), null);
  assert.equal(parseTimeOfDay(undefined), null);
});
