const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_AVAILABILITY_HORIZON_DAYS,
  PAST_START_TOLERANCE_MS,
  isExplicitOffsetRfc3339,
  validateCalendarAvailabilityRequest,
  calculateCalendarAvailability,
} = require("../../src/helpers/calendarAvailability.js");

const NOW = new Date("2026-08-25T09:00:00.000Z");

function event(start, end, overrides = {}) {
  return {
    start_time: start,
    end_time: end,
    status: "confirmed",
    availability_status: "busy",
    is_all_day: 0,
    ...overrides,
  };
}

test("explicit-offset RFC3339 validation rejects ambiguous and impossible timestamps", () => {
  assert.equal(isExplicitOffsetRfc3339("2026-08-25T14:30:00+05:30"), true);
  assert.equal(isExplicitOffsetRfc3339("2026-08-25T09:00:00.123456Z"), true);

  for (const invalid of [
    "2026-08-25T09:00:00",
    "2026-08-25 09:00:00Z",
    "2026-08-25",
    "2026-02-30T09:00:00Z",
    "2026-08-25T24:00:00Z",
    "2026-08-25T09:00:60Z",
    "2026-08-25T09:00:00+24:00",
  ]) {
    assert.equal(isExplicitOffsetRfc3339(invalid), false, invalid);
  }
});

test("request validation applies defaults, clamps a slightly stale start, and canonicalizes UTC", () => {
  const normalized = validateCalendarAvailabilityRequest(
    {
      start: new Date(NOW.getTime() - PAST_START_TOLERANCE_MS).toISOString(),
      end: "2026-08-25T12:00:00+01:00",
    },
    NOW
  );

  assert.deepEqual(normalized, {
    start: "2026-08-25T09:00:00.000Z",
    end: "2026-08-25T11:00:00.000Z",
    minimumSlotMinutes: 30,
    bufferMinutes: 0,
    maxResults: 10,
  });
  assert.equal(MAX_AVAILABILITY_HORIZON_DAYS, 31);
});

test("request validation rejects unknown fields, invalid bounds, stale starts, and excessive horizons", () => {
  const base = {
    start: NOW.toISOString(),
    end: "2026-08-25T12:00:00.000Z",
  };

  assert.throws(
    () => validateCalendarAvailabilityRequest({ ...base, unexpected: true }, NOW),
    /Unknown calendar availability option/
  );
  assert.throws(
    () =>
      validateCalendarAvailabilityRequest(
        { ...base, start: new Date(NOW.getTime() - PAST_START_TOLERANCE_MS - 1).toISOString() },
        NOW
      ),
    /more than 5 minutes in the past/
  );
  assert.throws(
    () =>
      validateCalendarAvailabilityRequest(
        {
          ...base,
          end: new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000 + 1).toISOString(),
        },
        NOW
      ),
    /31 local calendar days/
  );
  assert.throws(
    () =>
      validateCalendarAvailabilityRequest(
        {
          ...base,
          end: new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000).toISOString(),
          bufferMinutes: 1,
        },
        NOW
      ),
    /end plus buffer/
  );

  for (const [name, value] of [
    ["minimumSlotMinutes", 4],
    ["minimumSlotMinutes", 481],
    ["bufferMinutes", -1],
    ["bufferMinutes", 121],
    ["maxResults", 0],
    ["maxResults", 21],
  ]) {
    assert.throws(
      () => validateCalendarAvailabilityRequest({ ...base, [name]: value }, NOW),
      new RegExp(name)
    );
  }
});

test("request horizon spans 31 local calendar days across fall-back DST", () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const localNow = new Date("2026-10-30T09:00:00-04:00");
    const endAtLocalHorizon = "2026-11-30T09:00:00-05:00";
    const normalized = validateCalendarAvailabilityRequest(
      {
        start: localNow.toISOString(),
        end: endAtLocalHorizon,
      },
      localNow
    );

    assert.equal(normalized.end, "2026-11-30T14:00:00.000Z");
    assert.equal(Date.parse(normalized.end) - localNow.getTime(), 745 * 60 * 60 * 1000);
    assert.throws(
      () =>
        validateCalendarAvailabilityRequest(
          {
            start: localNow.toISOString(),
            end: "2026-11-30T09:00:00.001-05:00",
          },
          localNow
        ),
      /31 local calendar days/
    );
    assert.throws(
      () =>
        validateCalendarAvailabilityRequest(
          {
            start: localNow.toISOString(),
            end: endAtLocalHorizon,
            bufferMinutes: 1,
          },
          localNow
        ),
      /end plus buffer/
    );
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test("busy intervals are clipped, buffered, and merged when they overlap or touch", () => {
  const result = calculateCalendarAvailability(
    [
      event("2026-08-25T10:00:00Z", "2026-08-25T11:00:00Z", { summary: "Private" }),
      event("2026-08-25T11:30:00Z", "2026-08-25T12:00:00Z"),
      event("2026-08-25T16:30:00Z", "2026-08-25T18:00:00Z"),
    ],
    {
      start: "2026-08-25T09:00:00Z",
      end: "2026-08-25T17:00:00Z",
      minimumSlotMinutes: 30,
      bufferMinutes: 15,
      maxResults: 20,
    },
    NOW
  );

  assert.deepEqual(result, {
    busy: [
      { start: "2026-08-25T09:45:00.000Z", end: "2026-08-25T12:15:00.000Z" },
      { start: "2026-08-25T16:15:00.000Z", end: "2026-08-25T17:00:00.000Z" },
    ],
    availableSlots: [
      {
        start: "2026-08-25T09:00:00.000Z",
        end: "2026-08-25T09:45:00.000Z",
        durationMinutes: 45,
      },
      {
        start: "2026-08-25T12:15:00.000Z",
        end: "2026-08-25T16:15:00.000Z",
        durationMinutes: 240,
      },
    ],
    hasMore: false,
    isEntireRangeFree: false,
  });
  assert.equal(JSON.stringify(result).includes("Private"), false);
});

test("half-open boundaries do not block unless their buffer enters the requested window", () => {
  const request = {
    start: "2026-08-25T09:00:00Z",
    end: "2026-08-25T17:00:00Z",
    minimumSlotMinutes: 5,
    bufferMinutes: 0,
    maxResults: 20,
  };
  const result = calculateCalendarAvailability(
    [
      event("2026-08-25T08:00:00Z", "2026-08-25T09:00:00Z"),
      event("2026-08-25T17:00:00Z", "2026-08-25T18:00:00Z"),
      event("2026-08-25T08:30:00Z", "2026-08-25T09:30:00Z"),
      event("2026-08-25T16:30:00Z", "2026-08-25T18:00:00Z"),
    ],
    request,
    NOW
  );

  assert.deepEqual(result.busy, [
    { start: "2026-08-25T09:00:00.000Z", end: "2026-08-25T09:30:00.000Z" },
    { start: "2026-08-25T16:30:00.000Z", end: "2026-08-25T17:00:00.000Z" },
  ]);
  assert.deepEqual(result.availableSlots, [
    {
      start: "2026-08-25T09:30:00.000Z",
      end: "2026-08-25T16:30:00.000Z",
      durationMinutes: 420,
    },
  ]);
});

test("a post-event buffer blocks time after an event has ended", () => {
  const result = calculateCalendarAvailability(
    [event("2026-08-25T08:00:00Z", "2026-08-25T08:30:00Z")],
    {
      start: "2026-08-25T09:00:00Z",
      end: "2026-08-25T11:00:00Z",
      minimumSlotMinutes: 5,
      bufferMinutes: 60,
    },
    NOW
  );

  assert.deepEqual(result.busy, [
    { start: "2026-08-25T09:00:00.000Z", end: "2026-08-25T09:30:00.000Z" },
  ]);
  assert.deepEqual(result.availableSlots, [
    {
      start: "2026-08-25T09:30:00.000Z",
      end: "2026-08-25T11:00:00.000Z",
      durationMinutes: 90,
    },
  ]);
});

test("free, cancelled, and self-declined rows do not block time", () => {
  const declinedAttendees = JSON.stringify([
    { email: "me@example.com", self: true, responseStatus: "declined" },
  ]);
  const result = calculateCalendarAvailability(
    [
      event("2026-08-25T10:00:00Z", "2026-08-25T11:00:00Z", {
        availability_status: "free",
      }),
      event("2026-08-25T11:00:00Z", "2026-08-25T12:00:00Z", {
        attendees: declinedAttendees,
      }),
      event("2026-08-25T12:00:00Z", "2026-08-25T13:00:00Z", {
        status: "cancelled",
      }),
      event("2026-08-25T13:00:00Z", "2026-08-25T14:00:00Z", {
        self_response_status: "declined",
        availability_status: "busy",
        attendees: JSON.stringify([
          { email: "me@example.com", self: true, responseStatus: "accepted" },
        ]),
      }),
    ],
    {
      start: "2026-08-25T09:00:00Z",
      end: "2026-08-25T14:00:00Z",
    },
    NOW
  );

  assert.deepEqual(result.busy, []);
  assert.equal(result.isEntireRangeFree, true);
  assert.deepEqual(result.availableSlots, [
    {
      start: "2026-08-25T09:00:00.000Z",
      end: "2026-08-25T14:00:00.000Z",
      durationMinutes: 300,
    },
  ]);
});

test("tentative, busy, unavailable, unknown, and missing availability conservatively block", () => {
  const statuses = ["tentative", "busy", "unavailable", "unknown", undefined];
  for (const [index, availabilityStatus] of statuses.entries()) {
    const startHour = 9 + index;
    const result = calculateCalendarAvailability(
      [
        event(
          `2026-08-25T${String(startHour).padStart(2, "0")}:00:00Z`,
          `2026-08-25T${String(startHour + 1).padStart(2, "0")}:00:00Z`,
          { availability_status: availabilityStatus }
        ),
      ],
      {
        start: "2026-08-25T09:00:00Z",
        end: "2026-08-25T15:00:00Z",
        minimumSlotMinutes: 5,
      },
      NOW
    );
    assert.equal(result.busy.length, 1, String(availabilityStatus));
  }
});

test("maxResults truncates available slots and reports that more exist", () => {
  const result = calculateCalendarAvailability(
    [
      event("2026-08-25T10:00:00Z", "2026-08-25T11:00:00Z"),
      event("2026-08-25T12:00:00Z", "2026-08-25T13:00:00Z"),
      event("2026-08-25T14:00:00Z", "2026-08-25T15:00:00Z"),
    ],
    {
      start: "2026-08-25T09:00:00Z",
      end: "2026-08-25T17:00:00Z",
      maxResults: 2,
    },
    NOW
  );

  assert.equal(result.availableSlots.length, 2);
  assert.equal(result.hasMore, true);
  assert.equal(result.isEntireRangeFree, false);
});

test("slot durations report whole usable minutes", () => {
  const result = calculateCalendarAvailability(
    [event("2026-08-25T10:00:30Z", "2026-08-25T11:00:00Z")],
    {
      start: "2026-08-25T09:00:00Z",
      end: "2026-08-25T12:00:00Z",
      minimumSlotMinutes: 5,
    },
    NOW
  );

  assert.equal(result.availableSlots[0].durationMinutes, 60);
  assert.equal(Number.isSafeInteger(result.availableSlots[0].durationMinutes), true);
});

test("date-only all-day rows use device-local midnight instead of UTC", () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const localNow = new Date("2026-08-25T18:00:00-07:00");
    const result = calculateCalendarAvailability(
      [
        event("2026-08-25", "2026-08-26", {
          is_all_day: 1,
          availability_status: "unavailable",
        }),
      ],
      {
        start: "2026-08-25T18:00:00-07:00",
        end: "2026-08-25T22:00:00-07:00",
      },
      localNow
    );

    assert.deepEqual(result.busy, [
      { start: "2026-08-26T01:00:00.000Z", end: "2026-08-26T05:00:00.000Z" },
    ]);
    assert.deepEqual(result.availableSlots, []);
    assert.equal(result.isEntireRangeFree, false);
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});
