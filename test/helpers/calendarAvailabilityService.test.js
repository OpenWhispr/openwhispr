const test = require("node:test");
const assert = require("node:assert/strict");

const { getCalendarAvailability } = require("../../src/helpers/calendarAvailabilityService");

const NOW = new Date("2026-08-25T06:00:00.000Z");
const REQUEST = {
  start: "2026-08-25T07:00:00.000Z",
  end: "2026-08-25T12:00:00.000Z",
  minimumSlotMinutes: 30,
  bufferMinutes: 15,
  maxResults: 10,
};

const connectedManager = { isConnected: () => true };

test("calculates privacy-safe availability from connected provider caches", () => {
  const databaseManager = {
    getCalendarEventsInRange(start, end, providers) {
      assert.equal(start, "2026-08-25T06:45:00.000Z");
      assert.equal(end, "2026-08-25T12:15:00.000Z");
      assert.deepEqual(providers, ["google", "microsoft"]);
      return [
        {
          start_time: "2026-08-25T09:00:00.000Z",
          end_time: "2026-08-25T10:00:00.000Z",
          status: "confirmed",
          availability_status: "busy",
          summary: "Private board meeting",
          attendees: JSON.stringify([{ email: "private@example.com" }]),
          hangout_link: "https://private.example.com/meeting",
        },
      ];
    },
  };

  const result = getCalendarAvailability({
    request: REQUEST,
    databaseManager,
    calendarProviders: [
      { provider: "google", manager: connectedManager },
      { provider: "microsoft", manager: connectedManager },
      { provider: "apple", manager: { isConnected: () => false } },
    ],
    clock: () => NOW,
  });

  assert.deepEqual(result.busy, [
    { start: "2026-08-25T08:45:00.000Z", end: "2026-08-25T10:15:00.000Z" },
  ]);
  assert.deepEqual(result.coverage, { source: "local-calendar-cache", lookaheadDays: 7 });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("Private board meeting"), false);
  assert.equal(serialized.includes("private@example.com"), false);
  assert.equal(serialized.includes("private.example.com"), false);
});

test("rejects invalid input before querying the cache", () => {
  let queried = false;
  assert.throws(
    () =>
      getCalendarAvailability({
        request: { ...REQUEST, unexpected: true },
        databaseManager: {
          getCalendarEventsInRange: () => {
            queried = true;
          },
        },
        calendarProviders: [{ provider: "google", manager: connectedManager }],
        clock: () => NOW,
      }),
    /Unknown calendar availability option/
  );
  assert.equal(queried, false);
});

test("fails when no calendar is connected", () => {
  assert.throws(
    () =>
      getCalendarAvailability({
        request: REQUEST,
        databaseManager: { getCalendarEventsInRange: () => [] },
        calendarProviders: [],
        clock: () => NOW,
      }),
    /No calendar is connected/
  );
});
