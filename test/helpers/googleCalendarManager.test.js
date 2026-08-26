const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const managerModulePath = require.resolve("../../src/helpers/googleCalendarManager.js");
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

test("_syncCalendar fetches all pages when nextPageToken is returned", async () => {
  const GoogleCalendarManager = loadManagerModule();

  const upsertedEvents = [];
  let savedSyncToken = null;
  const prunedEventsMap = [];

  const databaseManager = {
    getGoogleAccounts: () => [],
    removeStaleCalendarEvents: (provider, calendarId, keptIds) => {
      prunedEventsMap.push({ provider, calendarId, keptIds });
    },
    upsertCalendarEvents: (events) => {
      upsertedEvents.push(...events);
    },
    removeCalendarEvents: () => {},
    updateCalendarSyncToken: (calendarId, syncToken) => {
      savedSyncToken = syncToken;
    },
    upsertContacts: () => {},
  };

  const reminderScheduler = {
    scheduleNextMeeting: () => {},
    reset: () => {},
  };

  const manager = new GoogleCalendarManager(databaseManager, null, reminderScheduler);

  const apiCalls = [];
  manager._apiGet = async (path, email) => {
    apiCalls.push({ path, email });
    if (!path.includes("pageToken=")) {
      return {
        items: [
          {
            id: "event-1",
            summary: "Event Page 1",
            start: { dateTime: "2026-08-12T10:00:00Z" },
            transparency: "transparent",
            attendees: [{ self: true, responseStatus: "declined" }],
          },
        ],
        nextPageToken: "token-page-2",
      };
    }
    if (path.includes("pageToken=token-page-2")) {
      return {
        items: [
          { id: "event-2", summary: "Event Page 2", start: { dateTime: "2026-08-12T11:00:00Z" } },
        ],
        nextSyncToken: "sync-token-final",
      };
    }
    throw new Error(`Unexpected path: ${path}`);
  };

  const calendar = { id: "cal-1", account_email: "test@example.com" };
  await manager._syncCalendar(calendar);

  assert.equal(apiCalls.length, 2, "should make 2 API calls for 2 pages");
  const firstPageParams = new URL(apiCalls[0].path, "https://www.googleapis.com").searchParams;
  const secondPageParams = new URL(apiCalls[1].path, "https://www.googleapis.com").searchParams;
  for (const name of ["singleEvents", "orderBy", "timeMin", "timeMax"]) {
    assert.equal(
      secondPageParams.get(name),
      firstPageParams.get(name),
      `should preserve ${name} across pages`
    );
  }
  assert.equal(secondPageParams.get("pageToken"), "token-page-2");
  assert.equal(upsertedEvents.length, 2, "should upsert events from both pages");
  assert.equal(upsertedEvents[0].id, "event-1");
  assert.equal(upsertedEvents[0].availability_status, "free");
  assert.equal(upsertedEvents[0].self_response_status, "declined");
  assert.equal(upsertedEvents[1].id, "event-2");
  assert.equal(savedSyncToken, "sync-token-final", "should save nextSyncToken from final page");
  assert.deepEqual(
    prunedEventsMap[0].keptIds,
    ["event-1", "event-2"],
    "full sync prune should keep events from all pages"
  );
});

test("_syncCalendar preserves incremental sync parameters across pages", async () => {
  const GoogleCalendarManager = loadManagerModule();

  const databaseManager = {
    getGoogleAccounts: () => [],
    removeStaleCalendarEvents: () => {},
    upsertCalendarEvents: () => {},
    removeCalendarEvents: () => {},
    updateCalendarSyncToken: () => {},
    upsertContacts: () => {},
  };
  const reminderScheduler = {
    scheduleNextMeeting: () => {},
    reset: () => {},
  };
  const manager = new GoogleCalendarManager(databaseManager, null, reminderScheduler);

  const apiCalls = [];
  manager._apiGet = async (path, email) => {
    apiCalls.push({ path, email });
    return apiCalls.length === 1
      ? { items: [], nextPageToken: "token-page-2" }
      : { items: [], nextSyncToken: "sync-token-final" };
  };

  await manager._syncCalendar({
    id: "cal-1",
    account_email: "test@example.com",
    sync_token: "sync-token-previous",
    sync_token_expires_at: Date.now() + 60_000,
  });

  assert.equal(apiCalls.length, 2);
  const firstPageParams = new URL(apiCalls[0].path, "https://www.googleapis.com").searchParams;
  const secondPageParams = new URL(apiCalls[1].path, "https://www.googleapis.com").searchParams;
  assert.equal(firstPageParams.get("singleEvents"), "true");
  assert.equal(firstPageParams.get("syncToken"), "sync-token-previous");
  assert.equal(secondPageParams.get("singleEvents"), "true");
  assert.equal(secondPageParams.get("syncToken"), "sync-token-previous");
  assert.equal(secondPageParams.get("pageToken"), "token-page-2");
});

test("_syncCalendar discards an expired sync token and re-runs a full window sync", async () => {
  const GoogleCalendarManager = loadManagerModule();

  let savedToken = null;
  const databaseManager = {
    getGoogleAccounts: () => [],
    removeStaleCalendarEvents: () => {},
    upsertCalendarEvents: () => {},
    removeCalendarEvents: () => {},
    updateCalendarSyncToken: (calendarId, syncToken, expiresAt) => {
      savedToken = { calendarId, syncToken, expiresAt };
    },
    upsertContacts: () => {},
  };
  const reminderScheduler = { scheduleNextMeeting: () => {}, reset: () => {} };
  const manager = new GoogleCalendarManager(databaseManager, null, reminderScheduler);

  const apiCalls = [];
  manager._apiGet = async (path) => {
    apiCalls.push(path);
    return { items: [], nextSyncToken: "sync-token-fresh" };
  };

  const before = Date.now();
  await manager._syncCalendar({
    id: "cal-1",
    account_email: "test@example.com",
    sync_token: "sync-token-stale",
    sync_token_expires_at: before - 1,
  });

  const params = new URL(apiCalls[0], "https://www.googleapis.com").searchParams;
  assert.equal(params.get("syncToken"), null, "expired token must not be reused");
  assert.ok(params.get("timeMin"), "full sync should send a fresh window");
  assert.ok(params.get("timeMax"), "full sync should send a fresh window");
  assert.equal(savedToken.syncToken, "sync-token-fresh");
  assert.ok(
    savedToken.expiresAt >= before + 23 * 60 * 60 * 1000,
    "new token should carry a fresh expiry"
  );
});

test("_syncCalendar keeps the stored expiry when an incremental sync reuses the token", async () => {
  const GoogleCalendarManager = loadManagerModule();

  let savedToken = null;
  const databaseManager = {
    getGoogleAccounts: () => [],
    removeStaleCalendarEvents: () => {},
    upsertCalendarEvents: () => {},
    removeCalendarEvents: () => {},
    updateCalendarSyncToken: (calendarId, syncToken, expiresAt) => {
      savedToken = { calendarId, syncToken, expiresAt };
    },
    upsertContacts: () => {},
  };
  const reminderScheduler = { scheduleNextMeeting: () => {}, reset: () => {} };
  const manager = new GoogleCalendarManager(databaseManager, null, reminderScheduler);

  manager._apiGet = async () => ({ items: [], nextSyncToken: "sync-token-next" });

  const storedExpiry = Date.now() + 60_000;
  await manager._syncCalendar({
    id: "cal-1",
    account_email: "test@example.com",
    sync_token: "sync-token-previous",
    sync_token_expires_at: storedExpiry,
  });

  assert.equal(savedToken.syncToken, "sync-token-next");
  assert.equal(
    savedToken.expiresAt,
    storedExpiry,
    "incremental sync must not extend the pinned window's expiry"
  );
});

test("_syncCalendar preserves meeting links from Google event location and description", async () => {
  const GoogleCalendarManager = loadManagerModule();

  const upsertedEvents = [];
  const databaseManager = {
    getGoogleAccounts: () => [],
    removeStaleCalendarEvents: () => {},
    upsertCalendarEvents: (events) => {
      upsertedEvents.push(...events);
    },
    removeCalendarEvents: () => {},
    updateCalendarSyncToken: () => {},
    upsertContacts: () => {},
  };
  const reminderScheduler = {
    scheduleNextMeeting: () => {},
    reset: () => {},
  };
  const manager = new GoogleCalendarManager(databaseManager, null, reminderScheduler);

  manager._apiGet = async () => ({
    items: [
      {
        id: "location-link",
        summary: "Location call",
        location: "Zoom: https://example.zoom.us/j/123456789",
        start: { dateTime: "2026-08-14T10:00:00Z" },
        end: { dateTime: "2026-08-14T10:30:00Z" },
        status: "confirmed",
      },
      {
        id: "description-link",
        summary: "Description call",
        description: "Join via https://teams.live.com/meet/9876543210",
        start: { dateTime: "2026-08-14T11:00:00Z" },
        end: { dateTime: "2026-08-14T11:30:00Z" },
        status: "confirmed",
      },
    ],
    nextSyncToken: "sync-token-final",
  });

  await manager._syncCalendar({ id: "cal-1", account_email: "test@example.com" });

  assert.deepEqual(
    upsertedEvents.map(({ id, hangout_link, attendees_count }) => ({
      id,
      hangout_link,
      attendees_count,
    })),
    [
      {
        id: "location-link",
        hangout_link: "https://example.zoom.us/j/123456789",
        attendees_count: 0,
      },
      {
        id: "description-link",
        hangout_link: "https://teams.live.com/meet/9876543210",
        attendees_count: 0,
      },
    ]
  );
});
