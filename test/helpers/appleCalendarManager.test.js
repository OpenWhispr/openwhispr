const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const managerModulePath = require.resolve("../../src/helpers/appleCalendarManager.js");
const originalLoad = Module._load;

function loadManager() {
  delete require.cache[managerModulePath];
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === "electron") {
      return { BrowserWindow: { getAllWindows: () => [] } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(managerModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test("an unexpected helper exit schedules a restart while Apple Calendar is connected", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const AppleCalendarManager = loadManager();
    const databaseManager = {
      getAppleCalendars: () => [{ id: "calendar-1" }],
    };
    const manager = new AppleCalendarManager(databaseManager, {});
    const child = {};
    let restartCount = 0;
    manager._helperProcess = child;
    manager._scheduleHelperRestart = () => {
      restartCount += 1;
    };

    manager._onHelperGone(child);

    assert.equal(manager._helperProcess, null);
    assert.equal(restartCount, 1);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

test("_mapEvent falls back to a meeting link found in location or notes", () => {
  const AppleCalendarManager = loadManager();
  const manager = new AppleCalendarManager({}, {});

  const mapped = manager._mapEvent({
    id: "evt-1:1755165600",
    calendar_id: "calendar-1",
    title: "External call",
    start: "2026-08-14T10:00:00Z",
    end: "2026-08-14T10:30:00Z",
    is_all_day: false,
    status: "confirmed",
    location: "Zoom: https://example.zoom.us/j/123456789",
    notes_urls: [],
    attendees: [],
  });

  assert.equal(mapped.provider, "apple");
  assert.equal(mapped.hangout_link, "https://example.zoom.us/j/123456789");
  assert.equal(mapped.attendees_count, 0);
  assert.equal(mapped.attendees, null);
});

test("a deliberate stop prevents the exited child from scheduling a restart", () => {
  const AppleCalendarManager = loadManager();
  const databaseManager = {
    getAppleCalendars: () => [{ id: "calendar-1" }],
  };
  const manager = new AppleCalendarManager(databaseManager, {});
  const child = { kill: () => {} };
  let restartCount = 0;
  manager._helperProcess = child;
  manager._scheduleHelperRestart = () => {
    restartCount += 1;
  };

  manager.stop();
  manager._onHelperGone(child);

  assert.equal(restartCount, 0);
});

test("_mapEvent preserves EventKit availability and the current user's response", () => {
  const AppleCalendarManager = loadManager();
  const manager = new AppleCalendarManager({}, {});
  const mapped = manager._mapEvent({
    id: "evt-availability",
    calendar_id: "calendar-1",
    start: "2026-08-14T10:00:00Z",
    end: "2026-08-14T10:30:00Z",
    is_all_day: false,
    status: "confirmed",
    availability: "free",
    attendees: [{ email: "me@example.com", status: "declined", self: true }],
  });

  assert.equal(mapped.availability_status, "free");
  assert.equal(mapped.self_response_status, "declined");
});

test("rooms and resources are flagged in attendees and kept, with the user, out of contacts", () => {
  const AppleCalendarManager = loadManager();
  const saved = [];
  const synced = [];
  const manager = new AppleCalendarManager(
    {
      saveAppleCalendars: () => {},
      replaceAppleCalendarEvents: (events) => saved.push(...events),
      syncCalendarContacts: (...args) => synced.push(args),
    },
    { reconcileProvider: () => {}, scheduleNextMeeting: () => {} }
  );

  manager._applySnapshot({
    calendars: [{ id: "calendar-1" }],
    events: [
      {
        id: "evt-room",
        calendar_id: "calendar-1",
        start: "2026-08-14T10:00:00Z",
        end: "2026-08-14T10:30:00Z",
        is_all_day: false,
        status: "confirmed",
        attendees: [
          { email: "ana@example.com", name: "Ana", status: "accepted", self: false },
          {
            email: "boardroom@example.com",
            name: "Boardroom",
            status: "accepted",
            self: false,
            resource: true,
          },
          { email: "me@icloud.com", name: "Me", status: "accepted", self: true },
        ],
      },
    ],
  });

  const attendees = JSON.parse(saved[0].attendees);
  assert.equal(attendees[0].resource, undefined);
  assert.equal(attendees[1].resource, true);
  // Rows older builds stored for the room and the user are purged.
  assert.deepEqual(synced, [
    [
      "apple",
      null,
      [{ email: "ana@example.com", displayName: "Ana" }],
      ["boardroom@example.com", "me@icloud.com"],
    ],
  ]);
});

test("_mapEvent drops the organizer address only when the user organized the event", () => {
  const AppleCalendarManager = loadManager();
  const manager = new AppleCalendarManager({}, {});
  const event = {
    id: "evt-organizer",
    calendar_id: "calendar-1",
    start: "2026-08-14T10:00:00Z",
    end: "2026-08-14T10:30:00Z",
    is_all_day: false,
    status: "confirmed",
    organizer_email: "me@corp.test",
    attendees: [{ email: "ana@example.com", status: "accepted", self: false }],
  };

  assert.equal(manager._mapEvent({ ...event, organizer_self: true }).organizer_email, null);
  assert.equal(manager._mapEvent(event).organizer_email, "me@corp.test");
});
