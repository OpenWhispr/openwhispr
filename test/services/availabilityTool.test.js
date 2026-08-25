const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/tools/availabilityTool.ts");

const DAY_MS = 24 * 60 * 60 * 1000;

function pad(n) {
  return String(n).padStart(2, "0");
}

function localDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function stubEvents(events, calls = []) {
  global.window = {
    electronAPI: {
      calendarGetEventsInRange: async (fromIso, toIso) => {
        calls.push([fromIso, toIso]);
        return { success: true, events };
      },
    },
  };
}

test("a synced day returns free slots and survives serialization", async () => {
  const { availabilityTool } = await load();
  const tomorrow = new Date(Date.now() + DAY_MS);
  const date = localDate(tomorrow);
  stubEvents([
    {
      summary: "Standup",
      start_time: new Date(
        tomorrow.getFullYear(),
        tomorrow.getMonth(),
        tomorrow.getDate(),
        10,
        0
      ).toISOString(),
      end_time: new Date(
        tomorrow.getFullYear(),
        tomorrow.getMonth(),
        tomorrow.getDate(),
        10,
        30
      ).toISOString(),
      is_all_day: 0,
      status: "confirmed",
      attendees: null,
    },
  ]);

  const result = await availabilityTool.execute({ start_date: date });

  assert.equal(result.success, true);
  assert.equal(result.displayText, `Checked availability for ${date}`);
  const data = JSON.parse(JSON.stringify(result.data));
  assert.equal(typeof data.timezone, "string");
  assert.equal(data.days.length, 1);
  assert.deepEqual(data.days[0].free[0], { start: `${date}T09:00`, end: `${date}T10:00` });
  assert.deepEqual(data.days[0].busy, [
    { start: `${date}T10:00`, end: `${date}T10:30`, summary: "Standup", status: "confirmed" },
  ]);
});

test("the fetched range is padded by a day on each side", async () => {
  const { availabilityTool } = await load();
  const calls = [];
  stubEvents([], calls);
  const tomorrow = new Date(Date.now() + DAY_MS);
  const date = localDate(tomorrow);

  await availabilityTool.execute({ start_date: date, end_date: date });

  assert.equal(calls.length, 1);
  const [fromIso, toIso] = calls[0];
  const dayStart = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate());
  assert.equal(fromIso, new Date(dayStart.getTime() - DAY_MS).toISOString());
  assert.equal(toIso, new Date(dayStart.getTime() + 2 * DAY_MS).toISOString());
});

test("days beyond the sync horizon are marked unknown, not free", async () => {
  const { availabilityTool } = await load();
  stubEvents([]);
  const farOut = localDate(new Date(Date.now() + 40 * DAY_MS));

  const result = await availabilityTool.execute({ start_date: farOut });

  assert.equal(result.success, true);
  assert.deepEqual(result.data.days, [{ date: farOut, unknown: true }]);
});

test("past days are marked unknown because they are never synced", async () => {
  const { availabilityTool } = await load();
  stubEvents([]);
  const yesterday = localDate(new Date(Date.now() - DAY_MS));

  const result = await availabilityTool.execute({ start_date: yesterday });

  assert.deepEqual(result.data.days, [{ date: yesterday, unknown: true }]);
});

test("a reversed range is swapped and an oversize range is capped at 31 days", async () => {
  const { availabilityTool } = await load();
  stubEvents([]);
  const start = new Date(Date.now() + DAY_MS);
  const end = new Date(start.getTime() + 60 * DAY_MS);

  const result = await availabilityTool.execute({
    start_date: localDate(end),
    end_date: localDate(start),
  });

  assert.equal(result.success, true);
  assert.equal(result.data.days.length, 31);
  assert.equal(result.data.days[0].date, localDate(start));
});

test("invalid parameters fall back to defaults instead of failing", async () => {
  const { availabilityTool } = await load();
  stubEvents([]);
  const tomorrow = new Date(Date.now() + DAY_MS);
  const date = localDate(tomorrow);

  const result = await availabilityTool.execute({
    start_date: date,
    day_start: "18:00",
    day_end: "09:00",
  });

  assert.deepEqual(result.data.days[0].free, [{ start: `${date}T09:00`, end: `${date}T18:00` }]);
});

test("an unsuccessful IPC response fails the tool call", async () => {
  const { availabilityTool } = await load();
  global.window = {
    electronAPI: { calendarGetEventsInRange: async () => ({ success: false, events: [] }) },
  };

  const result = await availabilityTool.execute({});

  assert.equal(result.success, false);
  assert.equal(result.displayText, "Failed to check calendar availability");
});
