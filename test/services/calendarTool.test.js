const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/tools/calendarTool.ts");

// Rows shaped like the calendar_events table: start_time/end_time columns,
// meeting links in hangout_link or conference_data — never start/end/location.
function stubEvents(events, calls = []) {
  global.window = {
    electronAPI: {
      gcalGetUpcomingEvents: async (windowMinutes, options) => {
        calls.push([windowMinutes, options]);
        return { success: true, events };
      },
    },
  };
}

// The device's time zone, for the length of one test.
function inTimeZone(t, timeZone) {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  t.after(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
}

test("events map the real DB columns and survive serialization", async (t) => {
  inTimeZone(t, "Asia/Kolkata");
  const { calendarTool } = await load();
  stubEvents([
    {
      summary: "Standup",
      start_time: "2026-08-12 16:00:00",
      end_time: "2026-08-12 16:15:00",
      hangout_link: "https://meet.google.com/abc-defg-hij",
      conference_data: null,
    },
  ]);

  const result = await calendarTool.execute({ timeRange: "today" });

  assert.equal(result.success, true);
  const roundTripped = JSON.parse(JSON.stringify(result.data));
  assert.deepEqual(roundTripped, [
    {
      summary: "Standup",
      start: "2026-08-12 16:00:00",
      end: "2026-08-12 16:15:00",
      date: "2026-08-12",
      weekday: "Wednesday",
      startTime: "4:00 PM",
      endTime: "4:15 PM",
      timeZoneName: "GMT+5:30",
      joinUrl: "https://meet.google.com/abc-defg-hij",
    },
  ]);
});

test("each event gets its local date, weekday and times, across midnight and a DST change", async (t) => {
  inTimeZone(t, "America/Los_Angeles");
  // Friday noon: the week runs through Thursday Nov 5.
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-30T19:00:00Z") });
  const { calendarTool } = await load();
  stubEvents([
    // Stored in UTC, as Microsoft and Apple rows are: Friday evening in Los Angeles.
    { summary: "Late sync", start_time: "2026-10-31T06:30:00Z", end_time: "2026-10-31T07:15:00Z" },
    // Saturday 23:30 to Sunday 00:15, the night the clocks go back.
    {
      summary: "Cutover",
      start_time: "2026-10-31T23:30:00-07:00",
      end_time: "2026-11-01T00:15:00-07:00",
    },
    {
      summary: "After the change",
      start_time: "2026-11-02T17:00:00Z",
      end_time: "2026-11-02T18:00:00Z",
    },
  ]);

  const { data } = await calendarTool.execute({ timeRange: "week" });

  const facts = data.map(({ date, weekday, startTime, endTime, endDate, timeZoneName }) => ({
    date,
    weekday,
    startTime,
    endTime,
    endDate,
    timeZoneName,
  }));
  assert.deepEqual(facts, [
    {
      date: "2026-10-30",
      weekday: "Friday",
      startTime: "11:30 PM",
      endTime: "12:15 AM",
      endDate: "2026-10-31",
      timeZoneName: "GMT-7",
    },
    {
      date: "2026-10-31",
      weekday: "Saturday",
      startTime: "11:30 PM",
      endTime: "12:15 AM",
      endDate: "2026-11-01",
      timeZoneName: "GMT-7",
    },
    {
      date: "2026-11-02",
      weekday: "Monday",
      startTime: "9:00 AM",
      endTime: "10:00 AM",
      endDate: undefined,
      timeZoneName: "GMT-8",
    },
  ]);
});

for (const { transition, now, start, end, startTime, endTime, startOffset, endOffset } of [
  {
    transition: "fall back",
    now: "2026-10-30T19:00:00Z",
    start: "2026-11-01T08:30:00Z",
    end: "2026-11-01T09:15:00Z",
    startTime: "1:30 AM",
    endTime: "1:15 AM",
    startOffset: "GMT-7",
    endOffset: "GMT-8",
  },
  {
    transition: "spring forward",
    now: "2026-03-06T20:00:00Z",
    start: "2026-03-08T09:30:00Z",
    end: "2026-03-08T10:15:00Z",
    startTime: "1:30 AM",
    endTime: "3:15 AM",
    startOffset: "GMT-8",
    endOffset: "GMT-7",
  },
]) {
  test(`an event spanning the ${transition} transition preserves both offsets`, async (t) => {
    inTimeZone(t, "America/Los_Angeles");
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
    const { calendarTool } = await load();
    stubEvents([{ summary: "Maintenance", start_time: start, end_time: end }]);

    const result = await calendarTool.execute({ timeRange: "week" });

    assert.equal(result.success, true);
    assert.equal(result.data[0].startTime, startTime);
    assert.equal(result.data[0].endTime, endTime);
    assert.equal(result.data[0].timeZoneName, startOffset);
    assert.equal(result.data[0].endTimeZoneName, endOffset);
  });
}

test("all-day events are asked for and come back as their days", async (t) => {
  inTimeZone(t, "America/Los_Angeles");
  const { calendarTool } = await load();
  const calls = [];
  stubEvents(
    [
      // Google and Microsoft store plain dates, the end exclusive.
      {
        summary: "Out of office",
        start_time: "2026-10-26",
        end_time: "2026-10-31",
        is_all_day: 1,
      },
      // The Apple helper stores local midnight as a UTC instant.
      {
        summary: "Holiday",
        start_time: "2026-10-23T07:00:00Z",
        end_time: "2026-10-24T07:00:00Z",
        is_all_day: 1,
        hangout_link: null,
      },
    ],
    calls
  );

  const { data } = await calendarTool.execute({ timeRange: "week" });

  assert.deepEqual(calls[0][1], { includeAllDay: true });
  assert.deepEqual(JSON.parse(JSON.stringify(data)), [
    {
      summary: "Out of office",
      allDay: true,
      date: "2026-10-26",
      weekday: "Monday",
      endDate: "2026-10-30",
      joinUrl: null,
    },
    { summary: "Holiday", allDay: true, date: "2026-10-23", weekday: "Friday", joinUrl: null },
  ]);
});

test("the join link falls back to conference_data when hangout_link is empty", async () => {
  const { calendarTool } = await load();
  stubEvents([
    {
      summary: "Design review",
      start_time: "2026-08-12 17:00:00",
      end_time: "2026-08-12 18:00:00",
      hangout_link: null,
      conference_data: JSON.stringify({
        entryPoints: [{ entryPointType: "video", uri: "https://zoom.us/j/123456" }],
      }),
    },
  ]);

  const result = await calendarTool.execute({});

  assert.equal(result.data[0].joinUrl, "https://zoom.us/j/123456");
});

test("no events yields an empty payload with a plain summary", async () => {
  const { calendarTool } = await load();
  stubEvents([]);

  const result = await calendarTool.execute({ timeRange: "today" });

  assert.deepEqual(result, {
    success: true,
    data: [],
    displayText: "No events found for today",
  });
});

test("an unsuccessful IPC response fails the tool call", async () => {
  const { calendarTool } = await load();
  global.window = {
    electronAPI: { gcalGetUpcomingEvents: async () => ({ success: false }) },
  };

  const result = await calendarTool.execute({});

  assert.equal(result.success, false);
  assert.equal(result.displayText, "Failed to fetch calendar events");
});

test("the week range runs to the end of the sixth day after today, like today and tomorrow to midnight", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 22, 3, 17).getTime() });
  const { calendarTool } = await load();
  const calls = [];
  stubEvents([], calls);

  for (const timeRange of ["today", "tomorrow", "week"]) await calendarTool.execute({ timeRange });

  const minutesTo = (day) =>
    Math.ceil((new Date(2026, 9, day, 23, 59, 59, 999) - new Date(2026, 9, 22, 3, 17)) / 60000);
  assert.deepEqual(
    calls.map(([minutes]) => minutes),
    [minutesTo(22), minutesTo(23), minutesTo(28)]
  );
  assert.deepEqual(calls[2][1], { includeAllDay: true });
});

test("a meeting at the next midnight belongs to the next day, not today", async (t) => {
  inTimeZone(t, "America/Los_Angeles");
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-23T17:00:00Z") });
  const { calendarTool } = await load();
  stubEvents([
    {
      summary: "Late",
      start_time: "2026-10-23T23:59:00-07:00",
      end_time: "2026-10-24T00:30:00-07:00",
    },
    {
      summary: "Midnight",
      start_time: "2026-10-24T00:00:00-07:00",
      end_time: "2026-10-24T00:30:00-07:00",
    },
  ]);

  const { data } = await calendarTool.execute({ timeRange: "today" });

  assert.deepEqual(
    data.map((event) => event.summary),
    ["Late"]
  );
});

test("an event that doesn't block the user's time says so", async (t) => {
  inTimeZone(t, "America/Los_Angeles");
  const { calendarTool } = await load();
  stubEvents([
    {
      summary: "Working from home",
      start_time: "2026-10-23",
      end_time: "2026-10-24",
      is_all_day: 1,
      availability_status: "free",
    },
    { summary: "Out of office", start_time: "2026-10-23", end_time: "2026-10-24", is_all_day: 1 },
  ]);

  const { data } = await calendarTool.execute({ timeRange: "week" });

  assert.equal(data[0].free, true);
  assert.equal("free" in data[1], false);
  assert.match(calendarTool.description, /free marks an event that doesn't block/);
});
