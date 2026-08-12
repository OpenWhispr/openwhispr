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

  const manager = new GoogleCalendarManager(databaseManager, reminderScheduler);

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
