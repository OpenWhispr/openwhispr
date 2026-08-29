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

test("normalizeGraphDateTime keeps only the date for all-day events", () => {
  const { normalizeGraphDateTime } = loadManagerModule();

  assert.equal(
    normalizeGraphDateTime({ dateTime: "2026-07-22T00:00:00.0000000" }, true),
    "2026-07-22"
  );
});

test("_mapEvent stores all-day events as date-only local calendar days", () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const manager = new MicrosoftCalendarManager({}, {});

  const mapped = manager._mapEvent(
    {
      id: "evt-ooo",
      subject: "Out of office",
      start: { dateTime: "2026-07-22T00:00:00.0000000" },
      end: { dateTime: "2026-07-23T00:00:00.0000000" },
      isAllDay: true,
      isCancelled: false,
      showAs: "oof",
    },
    { id: "cal-1", account_email: "me@example.com" }
  );

  assert.equal(mapped.start_time, "2026-07-22");
  assert.equal(mapped.end_time, "2026-07-23");
  assert.equal(mapped.is_all_day, true);
  assert.equal(mapped.availability_status, "unavailable");
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
      showAs: "workingElsewhere",
      responseStatus: { response: "declined" },
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
  assert.equal(mapped.availability_status, "free");
  assert.equal(mapped.self_response_status, "declined");
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

function createManager(MicrosoftCalendarManager, upserted, contacts = [], overrides = {}) {
  return new MicrosoftCalendarManager(
    {
      removeStaleCalendarEvents: () => {},
      upsertCalendarEvents: (events) => upserted.push(...events),
      removeCalendarEvents: () => {},
      updateMicrosoftCalendarSyncToken: () => {},
      upsertContacts: (rows) => contacts.push(...rows),
      getCalendarEventById: () => null,
      ...overrides,
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
  const tokenWrites = [];
  const manager = createManager(MicrosoftCalendarManager, upserted, contacts, {
    updateMicrosoftCalendarSyncToken: (id, token, expiresAt) =>
      tokenWrites.push({ id, token, expiresAt }),
  });

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
  assert.match(masterFetches[0], /^\/me\/calendars\/cal-1\/events\/master-1\?\$select=/);

  const occurrence = upserted.find((event) => event.id === "occ-1");
  assert.equal(occurrence.summary, "Standup");
  assert.equal(occurrence.start_time, "2026-07-20T09:25:00Z");
  assert.equal(occurrence.hangout_link, "https://teams.microsoft.com/l/meetup-join/abc");
  assert.equal(occurrence.organizer_email, "organizer@example.com");
  assert.equal(occurrence.attendees_count, 1);
  assert.equal(upserted.find((event) => event.id === "occ-2").summary, "Standup");
  assert.equal(upserted.find((event) => event.id === "evt-1").summary, "One-off");
  assert.ok(contacts.some((contact) => contact.email === "me@example.com"));
  assert.ok(tokenWrites[0].expiresAt > Date.now() + 6 * 24 * 60 * 60 * 1000);
});

test("_syncCalendar inserts a never-seen stripped occurrence bare when the series master fetch fails", async () => {
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

test("_syncCalendar shortens the delta token TTL when a master fetch fails", async () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const upserted = [];
  const tokenWrites = [];
  const manager = createManager(MicrosoftCalendarManager, upserted, [], {
    updateMicrosoftCalendarSyncToken: (id, token, expiresAt) =>
      tokenWrites.push({ id, token, expiresAt }),
  });

  manager._apiGet = async (url) => {
    if (url.includes("/calendarView/delta")) {
      return { "@odata.deltaLink": "delta-link", value: [STRIPPED_OCCURRENCE] };
    }
    throw new Error("master gone");
  };

  await manager._syncCalendar({ id: "cal-1", account_email: "me@example.com" });

  assert.equal(tokenWrites.length, 1);
  assert.ok(
    tokenWrites[0].expiresAt <= Date.now() + 10 * 60 * 1000,
    `expected a shortened TTL, got expiry ${tokenWrites[0].expiresAt - Date.now()}ms out`
  );
});

// A bare stub has attendees_count 0 and no join link, which the reminder
// scheduler treats as a time block — it must not overwrite a full row.
test("_syncCalendar keeps the stored row when a stripped occurrence's master fetch fails", async () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const upserted = [];
  const staleKeepLists = [];
  const manager = createManager(MicrosoftCalendarManager, upserted, [], {
    getCalendarEventById: (id) => (id === "occ-1" ? { id, summary: "Standup" } : null),
    removeStaleCalendarEvents: (_provider, _calendarId, keepIds) => staleKeepLists.push(keepIds),
  });

  manager._apiGet = async (url) => {
    if (url.includes("/calendarView/delta")) {
      return {
        "@odata.deltaLink": "delta-link",
        value: [
          STRIPPED_OCCURRENCE,
          {
            id: "evt-1",
            subject: "One-off",
            start: { dateTime: "2026-07-20T17:00:00.0000000" },
            end: { dateTime: "2026-07-20T17:30:00.0000000" },
          },
        ],
      };
    }
    throw new Error("master gone");
  };

  // No sync_token → full sync, so the stale prune runs and must spare occ-1.
  await manager._syncCalendar({ id: "cal-1", account_email: "me@example.com" });

  assert.deepEqual(
    upserted.map((event) => event.id),
    ["evt-1"]
  );
  assert.deepEqual(staleKeepLists, [["occ-1", "evt-1"]]);
});
