const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const managerModulePath = require.resolve("../../src/helpers/microsoftCalendarManager.js");
const originalLoad = Module._load;

function loadManagerModule() {
  delete require.cache[managerModulePath];
  Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === "electron") {
      return { net: {}, BrowserWindow: { getAllWindows: () => [] } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(managerModulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test("normalizeGraphDateTime converts Graph timestamps to SQLite-parseable UTC", () => {
  const { normalizeGraphDateTime } = loadManagerModule();

  assert.equal(
    normalizeGraphDateTime({ dateTime: "2026-07-20T17:00:00.0000000" }),
    "2026-07-20T17:00:00Z"
  );
  assert.equal(normalizeGraphDateTime({ dateTime: "2026-07-20T17:00:00" }), "2026-07-20T17:00:00Z");
});

test("_mapEvent maps a Graph event to the shared calendar_events shape", () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const manager = new MicrosoftCalendarManager({}, {});
  const calendar = { id: "cal-1", account_email: "Me@Example.com" };

  const mapped = manager._mapEvent(
    {
      id: "evt-1",
      subject: "Standup",
      start: { dateTime: "2026-07-20T17:00:00.0000000" },
      end: { dateTime: "2026-07-20T17:30:00.0000000" },
      isAllDay: false,
      isCancelled: false,
      onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" },
      organizer: { emailAddress: { address: "organizer@example.com" } },
      attendees: [
        {
          emailAddress: { address: "me@example.com", name: "Me" },
          status: { response: "tentativelyAccepted" },
        },
        { emailAddress: { address: "other@example.com" }, status: { response: "notResponded" } },
      ],
    },
    calendar
  );

  assert.equal(mapped.provider, "microsoft");
  assert.equal(mapped.summary, "Standup");
  assert.equal(mapped.start_time, "2026-07-20T17:00:00Z");
  assert.equal(mapped.status, "confirmed");
  assert.equal(mapped.hangout_link, "https://teams.microsoft.com/l/meetup-join/abc");
  assert.equal(mapped.organizer_email, "organizer@example.com");
  assert.equal(mapped.attendees_count, 2);

  const attendees = JSON.parse(mapped.attendees);
  assert.deepEqual(attendees[0], {
    email: "me@example.com",
    displayName: "Me",
    responseStatus: "tentative",
    self: true,
  });
  assert.deepEqual(attendees[1], {
    email: "other@example.com",
    displayName: null,
    responseStatus: "needsAction",
    self: false,
  });
});

test("_mapEvent falls back to a meeting link found in location or body text", () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const manager = new MicrosoftCalendarManager({}, {});

  const mapped = manager._mapEvent(
    {
      id: "evt-2",
      subject: "External call",
      start: { dateTime: "2026-07-21T09:00:00.0000000" },
      end: { dateTime: "2026-07-21T10:00:00.0000000" },
      isAllDay: false,
      isCancelled: true,
      bodyPreview: "Join here: https://example.zoom.us/j/123456789.",
    },
    { id: "cal-1", account_email: "me@example.com" }
  );

  assert.equal(mapped.status, "cancelled");
  assert.equal(mapped.hangout_link, "https://example.zoom.us/j/123456789");
  assert.equal(mapped.attendees, null);
});
