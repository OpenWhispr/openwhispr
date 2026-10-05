const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/tools/calendarTool.ts");

// Rows shaped like the calendar_events table: start_time/end_time columns,
// meeting links in hangout_link or conference_data — never start/end/location.
function stubEvents(events, calls = []) {
  global.window = {
    electronAPI: {
      gcalGetUpcomingEvents: async (windowMinutes) => {
        calls.push(windowMinutes);
        return { success: true, events };
      },
    },
  };
}

test("events map the real DB columns and survive serialization", async () => {
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
      joinUrl: "https://meet.google.com/abc-defg-hij",
    },
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

test("the week range forwards a 7-day window", async () => {
  const { calendarTool } = await load();
  const calls = [];
  stubEvents([], calls);

  await calendarTool.execute({ timeRange: "week" });

  assert.deepEqual(calls, [10080]);
});
