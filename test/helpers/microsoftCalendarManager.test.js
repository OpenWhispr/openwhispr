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

function createManager(MicrosoftCalendarManager, upserted, contacts = []) {
  return new MicrosoftCalendarManager(
    {
      removeStaleCalendarEvents: () => {},
      upsertCalendarEvents: (events) => upserted.push(...events),
      removeCalendarEvents: () => {},
      updateMicrosoftCalendarSyncToken: () => {},
      upsertContacts: (rows) => contacts.push(...rows),
    },
    {}
  );
}

const STRIPPED_OCCURRENCE = {
  id: "occ-1",
  type: "occurrence",
  seriesMasterId: "master-1",
  start: { dateTime: "2026-07-20T09:25:00.0000000" },
  end: { dateTime: "2026-07-20T09:30:00.0000000" },
};

test("_syncCalendar backfills stripped recurring occurrences from their series master", async () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const upserted = [];
  const contacts = [];
  const manager = createManager(MicrosoftCalendarManager, upserted, contacts);

  const masterFetches = [];
  manager._apiGet = async (url) => {
    if (url.includes("/calendarView/delta")) {
      return {
        "@odata.deltaLink": "delta-link",
        value: [
          STRIPPED_OCCURRENCE,
          {
            ...STRIPPED_OCCURRENCE,
            id: "occ-2",
            start: { dateTime: "2026-07-21T09:25:00.0000000" },
            end: { dateTime: "2026-07-21T09:30:00.0000000" },
          },
          {
            id: "evt-1",
            subject: "One-off",
            start: { dateTime: "2026-07-20T17:00:00.0000000" },
            end: { dateTime: "2026-07-20T17:30:00.0000000" },
          },
        ],
      };
    }
    masterFetches.push(url);
    return {
      id: "master-1",
      subject: "Standup",
      isAllDay: false,
      onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" },
      organizer: { emailAddress: { address: "organizer@example.com" } },
      attendees: [
        {
          emailAddress: { address: "me@example.com", name: "Me" },
          status: { response: "accepted" },
        },
      ],
    };
  };

  await manager._syncCalendar({ id: "cal-1", account_email: "me@example.com" });

  assert.equal(masterFetches.length, 1);
  assert.match(masterFetches[0], /^\/me\/events\/master-1\?\$select=/);

  const occurrence = upserted.find((event) => event.id === "occ-1");
  assert.equal(occurrence.summary, "Standup");
  assert.equal(occurrence.start_time, "2026-07-20T09:25:00Z");
  assert.equal(occurrence.hangout_link, "https://teams.microsoft.com/l/meetup-join/abc");
  assert.equal(occurrence.organizer_email, "organizer@example.com");
  assert.equal(occurrence.attendees_count, 1);
  assert.equal(upserted.find((event) => event.id === "occ-2").summary, "Standup");
  assert.equal(upserted.find((event) => event.id === "evt-1").summary, "One-off");
  assert.ok(contacts.some((contact) => contact.email === "me@example.com"));
});

test("_syncCalendar keeps stripped occurrences when the series master fetch fails", async () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const upserted = [];
  const manager = createManager(MicrosoftCalendarManager, upserted);

  manager._apiGet = async (url) => {
    if (url.includes("/calendarView/delta")) {
      return { "@odata.deltaLink": "delta-link", value: [STRIPPED_OCCURRENCE] };
    }
    throw new Error("master gone");
  };

  await manager._syncCalendar({ id: "cal-1", account_email: "me@example.com" });

  assert.equal(upserted.length, 1);
  assert.equal(upserted[0].id, "occ-1");
  assert.equal(upserted[0].summary, null);
  assert.equal(upserted[0].start_time, "2026-07-20T09:25:00Z");
});
