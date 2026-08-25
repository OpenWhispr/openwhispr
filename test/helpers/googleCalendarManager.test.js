const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const managerModulePath = require.resolve("../../src/helpers/googleCalendarManager.js");
const originalLoad = Module._load;
const DAY_MS = 24 * 60 * 60 * 1000;
const BUFFER_COVERAGE_MS = 120 * 60 * 1000;
const ALL_DAY_TIMEZONE_PADDING_MS = 48 * 60 * 60 * 1000;

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
    updateCalendarSyncToken: (calendarId, syncToken, expiresAt) => {
      savedSyncToken = { calendarId, syncToken, expiresAt };
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
            attendees: [{ email: "test@example.com", self: true, responseStatus: "declined" }],
          },
        ],
        nextPageToken: "token-page-2",
      };
    }
    if (path.includes("pageToken=token-page-2")) {
      return {
        items: [
          {
            id: "event-2",
            summary: "Event Page 2",
            start: { dateTime: "2026-08-12T11:00:00Z" },
            attendees: [{ email: "test@example.com", self: true, responseStatus: "futureStatus" }],
          },
        ],
        nextSyncToken: "sync-token-final",
      };
    }
    throw new Error(`Unexpected path: ${path}`);
  };

  const calendar = { id: "cal-1", account_email: "test@example.com" };
  const syncStartedAt = Date.now();
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
  const fullWindowMs =
    Date.parse(firstPageParams.get("timeMax")) - Date.parse(firstPageParams.get("timeMin"));
  const expectedFullWindowMs = 14 * DAY_MS + BUFFER_COVERAGE_MS + 2 * ALL_DAY_TIMEZONE_PADDING_MS;
  assert.ok(fullWindowMs >= expectedFullWindowMs - 1000);
  assert.ok(fullWindowMs <= expectedFullWindowMs + 1000);
  const timeMinMs = Date.parse(firstPageParams.get("timeMin"));
  assert.ok(timeMinMs >= syncStartedAt - BUFFER_COVERAGE_MS - ALL_DAY_TIMEZONE_PADDING_MS);
  assert.ok(timeMinMs <= Date.now() - BUFFER_COVERAGE_MS - ALL_DAY_TIMEZONE_PADDING_MS);
  assert.equal(secondPageParams.get("pageToken"), "token-page-2");
  assert.equal(upsertedEvents.length, 2, "should upsert events from both pages");
  assert.equal(upsertedEvents[0].id, "event-1");
  assert.equal(upsertedEvents[1].id, "event-2");
  assert.deepEqual(
    upsertedEvents.map((event) => event.availability_status),
    ["free", "busy"]
  );
  assert.deepEqual(
    upsertedEvents.map((event) => event.self_response_status),
    ["declined", "needsAction"]
  );
  assert.equal(savedSyncToken.calendarId, "cal-1");
  assert.equal(savedSyncToken.syncToken, "sync-token-final");
  assert.ok(savedSyncToken.expiresAt >= syncStartedAt + 7 * DAY_MS);
  assert.ok(savedSyncToken.expiresAt <= Date.now() + 7 * DAY_MS);
  assert.deepEqual(
    prunedEventsMap[0].keptIds,
    ["event-1", "event-2"],
    "full sync prune should keep events from all pages"
  );
});

test("fetchCalendars paginates each account and rejects after other accounts finish", async () => {
  const GoogleCalendarManager = loadManagerModule();
  const saved = [];
  let primarySelectionCalls = 0;
  let deselectionCleanupCalls = 0;
  const manager = new GoogleCalendarManager(
    {
      saveGoogleCalendars: (calendars, email) => saved.push({ calendars, email }),
      applyPrimaryOnlyToSelection: () => primarySelectionCalls++,
      removeEventsFromDeselectedCalendars: () => deselectionCleanupCalls++,
    },
    null,
    { scheduleNextMeeting: () => {}, reset: () => {} }
  );
  manager.addAccount("failed@example.com");
  manager.addAccount("ok@example.com");
  manager._lastSuccessfulAvailabilityRefreshAt = Date.now();

  const calls = [];
  manager._apiGet = async (path, email) => {
    calls.push({ path, email });
    if (email === "failed@example.com") {
      if (path.includes("pageToken=")) throw new Error("account unavailable");
      return {
        items: [{ id: "partial", summary: "Must not be saved" }],
        nextPageToken: "failing page",
      };
    }
    if (!path.includes("pageToken=")) {
      return {
        items: [{ id: "cal-1", summary: "Primary", primary: true }],
        nextPageToken: "next page",
      };
    }
    return { items: [{ id: "cal-2", summary: "Team", backgroundColor: "#123456" }] };
  };

  await assert.rejects(manager.fetchCalendars(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.match(error.errors[0].message, /failed@example\.com/);
    return true;
  });

  assert.deepEqual(
    calls.map(({ email }) => email),
    ["failed@example.com", "failed@example.com", "ok@example.com", "ok@example.com"]
  );
  assert.equal(
    new URL(calls[3].path, "https://www.googleapis.com").searchParams.get("pageToken"),
    "next page"
  );
  assert.equal(saved.length, 1, "a failed page must not persist a partial account snapshot");
  assert.equal(saved[0].email, "ok@example.com");
  assert.deepEqual(
    saved[0].calendars.map(({ id }) => id),
    ["cal-1", "cal-2"]
  );
  assert.equal(primarySelectionCalls, 1);
  assert.equal(deselectionCleanupCalls, 1);
  assert.equal(manager._lastSuccessfulAvailabilityRefreshAt, 0);
});

test("syncEvents attempts every selected calendar before rejecting aggregate failures", async () => {
  const GoogleCalendarManager = loadManagerModule();
  let scheduleCalls = 0;
  const manager = new GoogleCalendarManager(
    {
      getSelectedCalendars: () => [
        { id: "failed", account_email: "one@example.com" },
        { id: "succeeded", account_email: "two@example.com" },
      ],
    },
    null,
    { scheduleNextMeeting: () => scheduleCalls++, reset: () => {} }
  );
  const attempted = [];
  manager._syncCalendar = async (calendar) => {
    attempted.push(calendar.id);
    if (calendar.id === "failed") throw new Error("calendar unavailable");
  };
  manager._lastSuccessfulAvailabilityRefreshAt = Date.now();

  await assert.rejects(manager.syncEvents(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.match(error.errors[0].message, /Google calendar failed/);
    return true;
  });
  assert.deepEqual(attempted, ["failed", "succeeded"]);
  assert.equal(scheduleCalls, 1, "partial successes still need reminder rescheduling");
  assert.equal(manager._lastSuccessfulAvailabilityRefreshAt, 0);
});

test("syncEvents coalesces concurrent callers", async () => {
  const GoogleCalendarManager = loadManagerModule();
  const manager = new GoogleCalendarManager(
    { getSelectedCalendars: () => [{ id: "cal-1", account_email: "one@example.com" }] },
    null,
    { scheduleNextMeeting: () => {}, reset: () => {} }
  );
  let releaseSync;
  const syncGate = new Promise((resolve) => {
    releaseSync = resolve;
  });
  let syncCalls = 0;
  manager._syncCalendar = async () => {
    syncCalls++;
    await syncGate;
  };

  const first = manager.syncEvents();
  const second = manager.syncEvents();
  assert.strictEqual(second, first);
  assert.equal(syncCalls, 1);
  releaseSync();
  await first;
  assert.equal(syncCalls, 1);
});

test("refreshAvailability coalesces callers and reuses a recent successful refresh", async () => {
  const GoogleCalendarManager = loadManagerModule();
  const manager = new GoogleCalendarManager({}, null, {});
  const order = [];
  let releaseFetch;
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  manager.fetchCalendars = async () => {
    order.push("fetch");
    await fetchGate;
  };
  manager._runEventSync = async () => order.push("sync");

  const first = manager.refreshAvailability();
  const second = manager.refreshAvailability();
  assert.strictEqual(second, first);
  assert.deepEqual(order, ["fetch"]);
  releaseFetch();
  await first;
  assert.deepEqual(order, ["fetch", "sync"]);

  await manager.refreshAvailability();
  assert.deepEqual(order, ["fetch", "sync"]);

  manager.addAccount("new@example.com");
  await manager.refreshAvailability();
  assert.deepEqual(order, ["fetch", "sync", "fetch", "sync"]);
});

test("refreshAvailability does not reuse a timestamp from before a clock rollback", async () => {
  const GoogleCalendarManager = loadManagerModule();
  const manager = new GoogleCalendarManager({}, null, {});
  let refreshCalls = 0;
  manager.fetchCalendars = async () => refreshCalls++;
  manager._runEventSync = async () => {};

  await manager.refreshAvailability();
  manager._lastSuccessfulAvailabilityRefreshAt = Date.now() + 1000;
  await manager.refreshAvailability();

  assert.equal(refreshCalls, 2);
});

test("refreshAvailability syncs after a calendar-list failure and flattens failures", async () => {
  const GoogleCalendarManager = loadManagerModule();
  const manager = new GoogleCalendarManager({}, null, {});
  let syncCalls = 0;
  manager.fetchCalendars = async () => {
    throw new AggregateError([new Error("list failure")], "list failed");
  };
  manager._runEventSync = async () => {
    syncCalls++;
    throw new AggregateError([new Error("sync failure")], "sync failed");
  };

  await assert.rejects(manager.refreshAvailability(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map(({ message }) => message),
      ["list failure", "sync failure"]
    );
    return true;
  });
  assert.equal(syncCalls, 1);
});

test("refreshAvailability waits for an older sync before refreshing the calendar list", async () => {
  const GoogleCalendarManager = loadManagerModule();
  const order = [];
  const manager = new GoogleCalendarManager(
    { getSelectedCalendars: () => [{ id: "cal-1", account_email: "one@example.com" }] },
    null,
    { scheduleNextMeeting: () => {}, reset: () => {} }
  );
  let releaseSync;
  const syncGate = new Promise((resolve) => {
    releaseSync = resolve;
  });
  let syncCalls = 0;
  manager._syncCalendar = async () => {
    syncCalls++;
    order.push(`sync-${syncCalls}`);
    if (syncCalls === 1) await syncGate;
  };
  manager.fetchCalendars = async () => order.push("fetch");

  const olderSync = manager.syncEvents();
  const refresh = manager.refreshAvailability();
  await Promise.resolve();
  assert.deepEqual(order, ["sync-1"]);
  releaseSync();
  await Promise.all([olderSync, refresh]);
  assert.deepEqual(order, ["sync-1", "fetch", "sync-2"]);
});

test("refreshAvailability rejects when a queued calendar mutation invalidates its snapshot", async () => {
  const GoogleCalendarManager = loadManagerModule();
  const order = [];
  const manager = new GoogleCalendarManager(
    {
      updateCalendarSelection: () => order.push("update-selection"),
      removeEventsFromDeselectedCalendars: () => order.push("cleanup-selection"),
    },
    null,
    { scheduleNextMeeting: () => {}, reset: () => {} }
  );
  const fetchStarted = deferred();
  const releaseFetch = deferred();
  manager.fetchCalendars = async () => {
    order.push("refresh-fetch");
    fetchStarted.resolve();
    await releaseFetch.promise;
  };
  let syncCalls = 0;
  manager._runEventSync = async () => {
    syncCalls++;
    order.push(syncCalls === 1 ? "refresh-sync" : "mutation-sync");
  };

  const refresh = manager.refreshAvailability();
  await fetchStarted.promise;
  const mutation = manager.setCalendarSelection("cal-1", false);
  releaseFetch.resolve();

  await assert.rejects(refresh, (error) => {
    assert.equal(error.code, "CALENDAR_AVAILABILITY_CHANGED");
    return true;
  });
  await mutation;

  assert.deepEqual(order, [
    "refresh-fetch",
    "refresh-sync",
    "update-selection",
    "cleanup-selection",
    "mutation-sync",
  ]);
  assert.equal(manager._lastSuccessfulAvailabilityRefreshAt, 0);
});

test("disconnect invalidates a paused refresh before it can rewrite cleared calendar data", async () => {
  const GoogleCalendarManager = loadManagerModule();
  const writes = [];
  let scheduleCalls = 0;
  const databaseManager = {
    getSelectedCalendars: () => [{ id: "cal-1", account_email: "me@example.com" }],
    saveGoogleCalendars: () => writes.push("save-calendars"),
    applyPrimaryOnlyToSelection: () => writes.push("apply-selection"),
    removeEventsFromDeselectedCalendars: () => writes.push("remove-deselected"),
    removeStaleCalendarEvents: () => writes.push("remove-stale-events"),
    upsertCalendarEvents: () => writes.push("upsert-events"),
    removeCalendarEvents: () => writes.push("remove-events"),
    updateCalendarSyncToken: () => writes.push("save-sync-token"),
    upsertContacts: () => writes.push("upsert-contacts"),
    clearGoogleCalendarData: () => writes.push("disconnect-clear"),
    getGoogleAccounts: () => [],
  };
  const manager = new GoogleCalendarManager(databaseManager, null, {
    scheduleNextMeeting: () => scheduleCalls++,
    reset: () => {},
  });
  manager.addAccount("me@example.com");
  const eventRequestStarted = deferred();
  const releaseEventRequest = deferred();
  manager._apiGet = async (path) => {
    if (path.includes("/calendarList")) {
      return { items: [{ id: "cal-1", summary: "Primary", primary: true }] };
    }
    eventRequestStarted.resolve();
    await releaseEventRequest.promise;
    return {
      items: [
        {
          id: "event-after-disconnect",
          start: { dateTime: "2026-08-25T10:00:00Z" },
          end: { dateTime: "2026-08-25T11:00:00Z" },
        },
      ],
      nextSyncToken: "token-after-disconnect",
    };
  };

  const refresh = manager.refreshAvailability();
  await eventRequestStarted.promise;
  manager.disconnect();
  const scheduleCallsAfterDisconnect = scheduleCalls;
  const clearIndex = writes.indexOf("disconnect-clear");
  releaseEventRequest.resolve();

  await assert.rejects(refresh, (error) => {
    assert.equal(error.code, "CALENDAR_CONNECTION_CHANGED");
    return true;
  });
  assert.ok(clearIndex >= 0);
  assert.deepEqual(writes.slice(clearIndex + 1), []);
  assert.equal(writes.includes("upsert-events"), false);
  assert.equal(writes.includes("save-sync-token"), false);
  assert.equal(scheduleCalls, scheduleCallsAfterDisconnect);
  assert.equal(manager._lastSuccessfulAvailabilityRefreshAt, 0);
});

test("setCalendarSelection cleans deselected cache before starting its sync", async () => {
  const GoogleCalendarManager = loadManagerModule();
  const order = [];
  let selectedReads = 0;
  const databaseManager = {
    getSelectedCalendars: () => {
      selectedReads++;
      order.push(`read-${selectedReads}`);
      return selectedReads === 1 ? [{ id: "old-selection", account_email: "one@example.com" }] : [];
    },
    updateCalendarSelection: (id, selected) => order.push(`update-${id}-${selected}`),
    removeEventsFromDeselectedCalendars: (provider) => order.push(`cleanup-${provider}`),
  };
  const manager = new GoogleCalendarManager(databaseManager, null, {
    scheduleNextMeeting: () => {},
    reset: () => {},
  });
  manager.syncRunner.notifySuccess = () => order.push("notify-success");
  let releaseSync;
  const syncGate = new Promise((resolve) => {
    releaseSync = resolve;
  });
  manager._syncCalendar = async () => {
    order.push("old-sync");
    await syncGate;
  };

  const oldSync = manager.syncEvents();
  const selectionChange = manager.setCalendarSelection("old-selection", false);
  await Promise.resolve();
  assert.deepEqual(order, ["read-1", "old-sync"]);
  releaseSync();
  await Promise.all([oldSync, selectionChange]);

  assert.deepEqual(order, [
    "read-1",
    "old-sync",
    "update-old-selection-false",
    "cleanup-google",
    "read-2",
    "notify-success",
  ]);
});

test("setPrimaryOnly waits for an older sync and forces a post-mutation sync", async () => {
  const GoogleCalendarManager = loadManagerModule();
  let selectedReads = 0;
  const manager = new GoogleCalendarManager(
    {
      getSelectedCalendars: () => [
        {
          id: selectedReads++ === 0 ? "old-selection" : "fresh-selection",
          account_email: "me@example.com",
        },
      ],
    },
    null,
    { scheduleNextMeeting: () => {}, reset: () => {} }
  );
  manager.addAccount("me@example.com");
  const oldSyncStarted = deferred();
  const releaseOldSync = deferred();
  const order = [];
  manager._syncCalendar = async (calendar) => {
    order.push(`${calendar.id}-start`);
    if (calendar.id === "old-selection") {
      oldSyncStarted.resolve();
      await releaseOldSync.promise;
      order.push("old-selection-end");
    }
  };
  manager.fetchCalendars = async () => order.push("fetch-calendars");

  const oldSync = manager.syncEvents();
  await oldSyncStarted.promise;
  const primaryChange = manager.setPrimaryOnly(false);
  await Promise.resolve();
  assert.deepEqual(order, ["old-selection-start"]);
  releaseOldSync.resolve();
  await Promise.all([oldSync, primaryChange]);

  assert.deepEqual(order, [
    "old-selection-start",
    "old-selection-end",
    "fetch-calendars",
    "fresh-selection-start",
  ]);
  assert.equal(manager.primaryOnly, false);
});

test("startOAuth waits for an older sync and forces a post-account sync", async () => {
  const GoogleCalendarManager = loadManagerModule();
  let selectedReads = 0;
  const manager = new GoogleCalendarManager(
    {
      getSelectedCalendars: () => [
        {
          id: selectedReads++ === 0 ? "old-selection" : "fresh-selection",
          account_email: "existing@example.com",
        },
      ],
    },
    null,
    { scheduleNextMeeting: () => {}, reset: () => {} }
  );
  manager.addAccount("existing@example.com");
  const oldSyncStarted = deferred();
  const releaseOldSync = deferred();
  const order = [];
  manager._syncCalendar = async (calendar) => {
    order.push(`${calendar.id}-start`);
    if (calendar.id === "old-selection") {
      oldSyncStarted.resolve();
      await releaseOldSync.promise;
      order.push("old-selection-end");
    }
  };
  manager.fetchCalendars = async (email) => order.push(`fetch-${email}`);
  manager.oauth.startOAuthFlow = async ({ shouldPersist }) => {
    assert.equal(shouldPersist(), true);
    return { success: true, email: "new@example.com" };
  };
  manager.syncRunner.start = () => {};
  manager._broadcastAccountsChanged = () => {};

  const oldSync = manager.syncEvents();
  await oldSyncStarted.promise;
  const oauth = manager.startOAuth();
  await Promise.resolve();
  assert.deepEqual(order, ["old-selection-start"]);
  releaseOldSync.resolve();
  await Promise.all([oldSync, oauth]);

  assert.deepEqual(order, [
    "old-selection-start",
    "old-selection-end",
    "fetch-new@example.com",
    "fresh-selection-start",
  ]);
  assert.equal(manager.accounts.has("new@example.com"), true);
});

test("startOAuth surfaces a connected account when the initial calendar fetch fails", async () => {
  const GoogleCalendarManager = loadManagerModule();
  const order = [];
  const manager = new GoogleCalendarManager({}, null, {
    scheduleNextMeeting: () => order.push("schedule-reminder"),
    reset: () => {},
  });
  manager.oauth.startOAuthFlow = async ({ shouldPersist }) => {
    assert.equal(shouldPersist(), true);
    return { success: true, email: "new@example.com" };
  };
  manager._broadcastAccountsChanged = () => order.push("broadcast-account");
  manager.syncRunner.start = () => order.push("start-sync-runner");
  manager.fetchCalendars = async () => {
    order.push("fetch-calendars");
    throw new Error("calendar list unavailable");
  };
  manager._runEventSync = async () => order.push("sync-events");

  const result = await manager.startOAuth();

  assert.equal(result.success, true);
  assert.equal(result.email, "new@example.com");
  assert.equal(manager.accounts.has("new@example.com"), true);
  assert.deepEqual(order, [
    "broadcast-account",
    "start-sync-runner",
    "fetch-calendars",
    "sync-events",
    "schedule-reminder",
  ]);
});

test("startOAuth passes a persistence guard that disconnect invalidates", async () => {
  const GoogleCalendarManager = loadManagerModule();
  const databaseManager = {
    clearGoogleCalendarData: () => {},
    getGoogleAccounts: () => [],
  };
  const manager = new GoogleCalendarManager(databaseManager, null, {
    scheduleNextMeeting: () => {},
    reset: () => {},
  });
  const oauthStarted = deferred();
  const releaseOAuth = deferred();
  let shouldPersistAfterDisconnect = true;
  manager.oauth.startOAuthFlow = async ({ shouldPersist }) => {
    oauthStarted.resolve();
    await releaseOAuth.promise;
    shouldPersistAfterDisconnect = shouldPersist();
    if (!shouldPersistAfterDisconnect) throw new Error("OAuth persistence invalidated");
    return { success: true, email: "new@example.com" };
  };
  manager.fetchCalendars = async () => assert.fail("must not fetch after disconnect");

  const oauth = manager.startOAuth();
  await oauthStarted.promise;
  manager.disconnect();
  releaseOAuth.resolve();

  await assert.rejects(oauth, /OAuth persistence invalidated/);
  assert.equal(shouldPersistAfterDisconnect, false);
  assert.equal(manager.accounts.has("new@example.com"), false);
});

test("concurrent selection and primary mutations execute serially", async () => {
  const GoogleCalendarManager = loadManagerModule();
  const order = [];
  let selectedReads = 0;
  const manager = new GoogleCalendarManager(
    {
      updateCalendarSelection: () => order.push("selection-update"),
      removeEventsFromDeselectedCalendars: () => order.push("selection-cleanup"),
      getSelectedCalendars: () => [
        {
          id: selectedReads++ === 0 ? "selection-sync" : "primary-sync",
          account_email: "me@example.com",
        },
      ],
    },
    null,
    { scheduleNextMeeting: () => {}, reset: () => {} }
  );
  manager.addAccount("me@example.com");
  const selectionSyncStarted = deferred();
  const releaseSelectionSync = deferred();
  manager._syncCalendar = async (calendar) => {
    order.push(`${calendar.id}-start`);
    if (calendar.id === "selection-sync") {
      selectionSyncStarted.resolve();
      await releaseSelectionSync.promise;
      order.push("selection-sync-end");
    }
  };
  manager.fetchCalendars = async () => order.push("primary-fetch");

  const selection = manager.setCalendarSelection("cal-1", false);
  const primary = manager.setPrimaryOnly(false);
  await selectionSyncStarted.promise;
  assert.deepEqual(order, ["selection-update", "selection-cleanup", "selection-sync-start"]);
  releaseSelectionSync.resolve();
  await Promise.all([selection, primary]);

  assert.deepEqual(order, [
    "selection-update",
    "selection-cleanup",
    "selection-sync-start",
    "selection-sync-end",
    "primary-fetch",
    "primary-sync-start",
  ]);
});

test("queued primary toggles preserve call order", async () => {
  const GoogleCalendarManager = loadManagerModule();
  const manager = new GoogleCalendarManager({ getSelectedCalendars: () => [] }, null, {
    scheduleNextMeeting: () => {},
    reset: () => {},
  });
  manager.addAccount("me@example.com");
  const firstFetchStarted = deferred();
  const releaseFirstFetch = deferred();
  const order = [];
  manager.fetchCalendars = async () => {
    order.push(`fetch-${manager.primaryOnly}`);
    if (manager.primaryOnly === false) {
      firstFetchStarted.resolve();
      await releaseFirstFetch.promise;
    }
  };

  const disable = manager.setPrimaryOnly(false);
  const enable = manager.setPrimaryOnly(true);
  await firstFetchStarted.promise;
  assert.deepEqual(order, ["fetch-false"]);
  releaseFirstFetch.resolve();
  await Promise.all([disable, enable]);

  assert.deepEqual(order, ["fetch-false", "fetch-true"]);
  assert.equal(manager.primaryOnly, true);
});

test("_syncCalendar preserves incremental sync parameters across pages", async () => {
  const GoogleCalendarManager = loadManagerModule();

  let savedTokenExpiresAt = null;
  const databaseManager = {
    getGoogleAccounts: () => [],
    removeStaleCalendarEvents: () => {},
    upsertCalendarEvents: () => {},
    removeCalendarEvents: () => {},
    updateCalendarSyncToken: (_calendarId, _syncToken, expiresAt) => {
      savedTokenExpiresAt = expiresAt;
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
    return apiCalls.length === 1
      ? { items: [], nextPageToken: "token-page-2" }
      : { items: [], nextSyncToken: "sync-token-final" };
  };

  const syncTokenExpiresAt = Date.now() + DAY_MS;
  await manager._syncCalendar({
    id: "cal-1",
    account_email: "test@example.com",
    sync_token: "sync-token-previous",
    sync_token_expires_at: syncTokenExpiresAt,
  });

  assert.equal(apiCalls.length, 2);
  const firstPageParams = new URL(apiCalls[0].path, "https://www.googleapis.com").searchParams;
  const secondPageParams = new URL(apiCalls[1].path, "https://www.googleapis.com").searchParams;
  assert.equal(firstPageParams.get("singleEvents"), "true");
  assert.equal(firstPageParams.get("syncToken"), "sync-token-previous");
  assert.equal(secondPageParams.get("singleEvents"), "true");
  assert.equal(secondPageParams.get("syncToken"), "sync-token-previous");
  assert.equal(secondPageParams.get("pageToken"), "token-page-2");
  assert.equal(savedTokenExpiresAt, syncTokenExpiresAt);
});

test("_syncCalendar replaces an expired token with a rolling full sync", async () => {
  const GoogleCalendarManager = loadManagerModule();

  let savedTokenExpiresAt = null;
  const databaseManager = {
    getGoogleAccounts: () => [],
    removeStaleCalendarEvents: () => {},
    upsertCalendarEvents: () => {},
    removeCalendarEvents: () => {},
    updateCalendarSyncToken: (_calendarId, _syncToken, expiresAt) => {
      savedTokenExpiresAt = expiresAt;
    },
    upsertContacts: () => {},
  };
  const manager = new GoogleCalendarManager(databaseManager, null, {
    scheduleNextMeeting: () => {},
    reset: () => {},
  });
  const apiCalls = [];
  manager._apiGet = async (path) => {
    apiCalls.push(path);
    return { items: [], nextSyncToken: "replacement-token" };
  };

  const syncStartedAt = Date.now();
  await manager._syncCalendar({
    id: "cal-1",
    account_email: "test@example.com",
    sync_token: "expired-token",
    sync_token_expires_at: Date.now() - 1,
  });

  const params = new URL(apiCalls[0], "https://www.googleapis.com").searchParams;
  assert.equal(params.get("syncToken"), null);
  assert.ok(params.get("timeMin"));
  assert.ok(params.get("timeMax"));
  assert.ok(savedTokenExpiresAt >= syncStartedAt + 7 * DAY_MS);
  assert.ok(savedTokenExpiresAt <= Date.now() + 7 * DAY_MS);
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
