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
          { id: "event-1", summary: "Event Page 1", start: { dateTime: "2026-08-12T10:00:00Z" } },
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
