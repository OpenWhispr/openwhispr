const test = require("node:test");
const assert = require("node:assert/strict");

const { getFreshCalendarAvailability } = require("../../src/helpers/calendarAvailabilityService");

const NOW = new Date("2026-08-25T06:00:00.000Z");
const REQUEST = {
  start: "2026-08-25T07:00:00.000Z",
  end: "2026-08-25T12:00:00.000Z",
  minimumSlotMinutes: 30,
  bufferMinutes: 15,
  maxResults: 10,
};

function manager(name, calls, { connected = true, fail = false } = {}) {
  return {
    isConnected: () => connected,
    refreshAvailability: async () => {
      calls.push(`refresh:${name}`);
      if (fail) throw new Error(`${name} refresh failed`);
    },
  };
}

test("refreshes every connected provider before calculating a privacy-safe result", async () => {
  const calls = [];
  const databaseManager = {
    getCalendarEventsInRange(start, end, providers) {
      calls.push("query");
      assert.equal(start, "2026-08-25T06:45:00.000Z");
      assert.equal(end, "2026-08-25T12:15:00.000Z");
      assert.deepEqual(providers, ["google", "microsoft", "apple"]);
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

  const result = await getFreshCalendarAvailability({
    request: REQUEST,
    databaseManager,
    calendarProviders: [
      { provider: "google", manager: manager("google", calls) },
      { provider: "microsoft", manager: manager("microsoft", calls) },
      { provider: "apple", manager: manager("apple", calls) },
      {
        provider: "apple",
        manager: manager("disconnected", calls, { connected: false }),
      },
    ],
    clock: () => NOW,
  });

  assert.deepEqual(calls.slice(0, 3).sort(), [
    "refresh:apple",
    "refresh:google",
    "refresh:microsoft",
  ]);
  assert.equal(calls.at(-1), "query");
  assert.deepEqual(result.busy, [
    { start: "2026-08-25T08:45:00.000Z", end: "2026-08-25T10:15:00.000Z" },
  ]);
  assert.equal(result.coverage.source, "local-calendar-cache");
  assert.equal(result.coverage.lookaheadDays, 7);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("Private board meeting"), false);
  assert.equal(serialized.includes("private@example.com"), false);
  assert.equal(serialized.includes("private.example.com"), false);
});

test("rejects invalid input before provider or database work", async () => {
  const calls = [];
  await assert.rejects(
    getFreshCalendarAvailability({
      request: { ...REQUEST, unexpected: true },
      databaseManager: { getCalendarEventsInRange: () => calls.push("query") },
      calendarProviders: [{ provider: "google", manager: manager("google", calls) }],
      clock: () => NOW,
    }),
    /Unknown calendar availability option/
  );
  assert.deepEqual(calls, []);
});

test("fails closed when no calendar is connected", async () => {
  await assert.rejects(
    getFreshCalendarAvailability({
      request: REQUEST,
      databaseManager: { getCalendarEventsInRange: () => [] },
      calendarProviders: [],
      clock: () => NOW,
    }),
    /No calendar is connected/
  );
});

test("does not query a partial cache when any connected provider refresh fails", async () => {
  const calls = [];
  await assert.rejects(
    getFreshCalendarAvailability({
      request: REQUEST,
      databaseManager: { getCalendarEventsInRange: () => calls.push("query") },
      calendarProviders: [
        { provider: "google", manager: manager("google", calls) },
        { provider: "microsoft", manager: manager("microsoft", calls, { fail: true }) },
      ],
      clock: () => NOW,
    }),
    /microsoft refresh failed/
  );
  assert.equal(calls.includes("query"), false);
});

test("fails closed when a provider disconnects during its refresh", async () => {
  const calls = [];
  let connected = true;
  const appleManager = {
    isConnected: () => connected,
    refreshAvailability: async () => {
      calls.push("refresh:apple");
      connected = false;
    },
  };

  await assert.rejects(
    getFreshCalendarAvailability({
      request: REQUEST,
      databaseManager: { getCalendarEventsInRange: () => calls.push("query") },
      calendarProviders: [{ provider: "apple", manager: appleManager }],
      clock: () => NOW,
    }),
    /Calendar connections changed while refreshing/
  );
  assert.deepEqual(calls, ["refresh:apple"]);
});

test("fails closed when a new provider connects during a refresh", async () => {
  const calls = [];
  let microsoftConnected = false;
  const googleManager = {
    isConnected: () => true,
    refreshAvailability: async () => {
      calls.push("refresh:google");
      microsoftConnected = true;
    },
  };
  const microsoftManager = {
    isConnected: () => microsoftConnected,
    refreshAvailability: async () => calls.push("refresh:microsoft"),
  };

  await assert.rejects(
    getFreshCalendarAvailability({
      request: REQUEST,
      databaseManager: { getCalendarEventsInRange: () => calls.push("query") },
      calendarProviders: [
        { provider: "google", manager: googleManager },
        { provider: "microsoft", manager: microsoftManager },
      ],
      clock: () => NOW,
    }),
    /Calendar connections changed while refreshing/
  );
  assert.deepEqual(calls, ["refresh:google"]);
});

test("clamps the result to refresh completion time and rejects an expired range", async () => {
  const calls = [];
  const times = [NOW, new Date("2026-08-25T08:00:00.000Z")];
  const result = await getFreshCalendarAvailability({
    request: REQUEST,
    databaseManager: {
      getCalendarEventsInRange(start) {
        calls.push(start);
        return [];
      },
    },
    calendarProviders: [{ provider: "google", manager: manager("google", calls) }],
    clock: () => times.shift(),
  });

  assert.equal(result.range.start, "2026-08-25T08:00:00.000Z");
  assert.equal(result.availableSlots[0].start, "2026-08-25T08:00:00.000Z");
  assert.equal(calls.at(-1), "2026-08-25T07:45:00.000Z");

  const expiredCalls = [];
  const expiredTimes = [NOW, new Date("2026-08-25T12:00:00.000Z")];
  await assert.rejects(
    getFreshCalendarAvailability({
      request: REQUEST,
      databaseManager: {
        getCalendarEventsInRange: () => expiredCalls.push("query"),
      },
      calendarProviders: [{ provider: "google", manager: manager("google", expiredCalls) }],
      clock: () => expiredTimes.shift(),
    }),
    /ended while calendars were refreshing/
  );
  assert.equal(expiredCalls.includes("query"), false);
});
