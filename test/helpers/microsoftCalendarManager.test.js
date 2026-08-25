const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const managerModulePath = require.resolve("../../src/helpers/microsoftCalendarManager.js");
const originalLoad = Module._load;
const DAY_MS = 24 * 60 * 60 * 1000;
const BUFFER_COVERAGE_MS = 120 * 60 * 1000;

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

test("normalizeGraphDateTime converts Graph timestamps to SQLite-parseable UTC", () => {
  const { normalizeGraphDateTime } = loadManagerModule();

  assert.equal(
    normalizeGraphDateTime({ dateTime: "2026-07-20T17:00:00.0000000" }),
    "2026-07-20T17:00:00Z"
  );
  assert.equal(normalizeGraphDateTime({ dateTime: "2026-07-20T17:00:00" }), "2026-07-20T17:00:00Z");
});

test("delta snapshots include conservative lookback and a 15-day forward window", () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const manager = new MicrosoftCalendarManager({}, {});
  const startedAt = Date.now();

  const params = new URL(manager._deltaUrl("calendar/id"), "https://graph.microsoft.com")
    .searchParams;
  const startMs = Date.parse(params.get("startDateTime"));
  const endMs = Date.parse(params.get("endDateTime"));

  assert.ok(startMs >= startedAt - DAY_MS - BUFFER_COVERAGE_MS);
  assert.ok(startMs <= Date.now() - DAY_MS - BUFFER_COVERAGE_MS);
  assert.ok(endMs >= startedAt + 15 * DAY_MS);
  assert.ok(endMs <= Date.now() + 15 * DAY_MS);
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
      showAs: "busy",
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
  assert.equal(mapped.availability_status, "busy");
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

test("fetchCalendars continues across accounts and aggregates account failures", async () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const saved = [];
  let primarySelectionCalls = 0;
  let deselectionCleanupCalls = 0;
  const manager = new MicrosoftCalendarManager(
    {
      saveMicrosoftCalendars: (calendars, email) => saved.push({ calendars, email }),
      applyMicrosoftPrimaryOnlyToSelection: () => primarySelectionCalls++,
      removeEventsFromDeselectedCalendars: () => deselectionCleanupCalls++,
    },
    { scheduleNextMeeting: () => {}, reset: () => {} }
  );
  manager.addAccount("failed@example.com");
  manager.addAccount("ok@example.com");
  manager._lastSuccessfulAvailabilityRefreshAt = Date.now();

  const calls = [];
  manager._apiGet = async (url, email) => {
    calls.push({ url, email });
    if (email === "failed@example.com") throw new Error("account unavailable");
    if (url.startsWith("/me/calendars")) {
      return {
        value: [{ id: "cal-1", name: "Primary", isDefaultCalendar: true }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendars?page=2",
      };
    }
    return { value: [{ id: "cal-2", name: "Team", hexColor: "#123456" }] };
  };

  await assert.rejects(manager.fetchCalendars(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.match(error.errors[0].message, /failed@example\.com/);
    return true;
  });

  assert.deepEqual(
    calls.map(({ email }) => email),
    ["failed@example.com", "ok@example.com", "ok@example.com"]
  );
  assert.equal(saved.length, 1);
  assert.deepEqual(
    saved[0].calendars.map(({ id }) => id),
    ["cal-1", "cal-2"]
  );
  assert.equal(primarySelectionCalls, 1);
  assert.equal(deselectionCleanupCalls, 1);
  assert.equal(manager._lastSuccessfulAvailabilityRefreshAt, 0);
});

test("syncEvents attempts every selected calendar before rejecting aggregate failures", async () => {
  const MicrosoftCalendarManager = loadManagerModule();
  let scheduleCalls = 0;
  const manager = new MicrosoftCalendarManager(
    {
      getSelectedMicrosoftCalendars: () => [
        { id: "failed", account_email: "one@example.com" },
        { id: "succeeded", account_email: "two@example.com" },
      ],
    },
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
    assert.match(error.errors[0].message, /Microsoft calendar failed/);
    return true;
  });
  assert.deepEqual(attempted, ["failed", "succeeded"]);
  assert.equal(scheduleCalls, 1);
  assert.equal(manager._lastSuccessfulAvailabilityRefreshAt, 0);
});

test("syncEvents coalesces concurrent callers", async () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const manager = new MicrosoftCalendarManager(
    {
      getSelectedMicrosoftCalendars: () => [{ id: "cal-1", account_email: "one@example.com" }],
    },
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
  const MicrosoftCalendarManager = loadManagerModule();
  const manager = new MicrosoftCalendarManager({}, {});
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
  const MicrosoftCalendarManager = loadManagerModule();
  const manager = new MicrosoftCalendarManager({}, {});
  let refreshCalls = 0;
  manager.fetchCalendars = async () => refreshCalls++;
  manager._runEventSync = async () => {};

  await manager.refreshAvailability();
  manager._lastSuccessfulAvailabilityRefreshAt = Date.now() + 1000;
  await manager.refreshAvailability();

  assert.equal(refreshCalls, 2);
});

test("refreshAvailability rejects when a queued primary mutation invalidates its snapshot", async () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const order = [];
  const manager = new MicrosoftCalendarManager(
    {},
    {
      scheduleNextMeeting: () => {},
      reset: () => {},
    }
  );
  manager.addAccount("me@example.com");
  const fetchStarted = deferred();
  const releaseFetch = deferred();
  let fetchCalls = 0;
  manager.fetchCalendars = async () => {
    fetchCalls++;
    order.push(`fetch-${fetchCalls}`);
    if (fetchCalls === 1) {
      fetchStarted.resolve();
      await releaseFetch.promise;
    }
  };
  let syncCalls = 0;
  manager._runEventSync = async () => {
    syncCalls++;
    order.push(syncCalls === 1 ? "refresh-sync" : "mutation-sync");
  };

  const refresh = manager.refreshAvailability();
  await fetchStarted.promise;
  const mutation = manager.setPrimaryOnly(false);
  releaseFetch.resolve();

  await assert.rejects(refresh, (error) => {
    assert.equal(error.code, "CALENDAR_AVAILABILITY_CHANGED");
    return true;
  });
  await mutation;

  assert.deepEqual(order, ["fetch-1", "refresh-sync", "fetch-2", "mutation-sync"]);
  assert.equal(manager.primaryOnly, false);
  assert.equal(manager._lastSuccessfulAvailabilityRefreshAt, 0);
});

test("disconnect invalidates a paused master backfill before it can rewrite cleared data", async () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const writes = [];
  let scheduleCalls = 0;
  const databaseManager = {
    getSelectedMicrosoftCalendars: () => [{ id: "cal-1", account_email: "me@example.com" }],
    saveMicrosoftCalendars: () => writes.push("save-calendars"),
    applyMicrosoftPrimaryOnlyToSelection: () => writes.push("apply-selection"),
    removeEventsFromDeselectedCalendars: () => writes.push("remove-deselected"),
    removeStaleCalendarEvents: () => writes.push("remove-stale-events"),
    upsertCalendarEvents: () => writes.push("upsert-events"),
    removeCalendarEvents: () => writes.push("remove-events"),
    updateMicrosoftCalendarSyncToken: () => writes.push("save-sync-token"),
    upsertContacts: () => writes.push("upsert-contacts"),
    getCalendarEventById: () => null,
    clearMicrosoftCalendarData: () => writes.push("disconnect-clear"),
    getMicrosoftAccounts: () => [],
  };
  const manager = new MicrosoftCalendarManager(databaseManager, {
    scheduleNextMeeting: () => scheduleCalls++,
    reset: () => {},
  });
  manager.addAccount("me@example.com");
  const masterRequestStarted = deferred();
  const releaseMasterRequest = deferred();
  manager._apiGet = async (url) => {
    if (url.startsWith("/me/calendars?$select=")) {
      return { value: [{ id: "cal-1", name: "Primary", isDefaultCalendar: true }] };
    }
    if (url.includes("/calendarView/delta")) {
      return { "@odata.deltaLink": "delta-after-disconnect", value: [STRIPPED_OCCURRENCE] };
    }
    masterRequestStarted.resolve();
    await releaseMasterRequest.promise;
    return { id: "master-1", subject: "Must not be saved" };
  };

  const refresh = manager.refreshAvailability();
  await masterRequestStarted.promise;
  manager.disconnect();
  const scheduleCallsAfterDisconnect = scheduleCalls;
  const clearIndex = writes.indexOf("disconnect-clear");
  releaseMasterRequest.resolve();

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

test("setPrimaryOnly waits for an older sync and forces a post-mutation sync", async () => {
  const MicrosoftCalendarManager = loadManagerModule();
  let selectedReads = 0;
  const manager = new MicrosoftCalendarManager(
    {
      getSelectedMicrosoftCalendars: () => [
        {
          id: selectedReads++ === 0 ? "old-selection" : "fresh-selection",
          account_email: "me@example.com",
        },
      ],
    },
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
  const MicrosoftCalendarManager = loadManagerModule();
  let selectedReads = 0;
  const manager = new MicrosoftCalendarManager(
    {
      getSelectedMicrosoftCalendars: () => [
        {
          id: selectedReads++ === 0 ? "old-selection" : "fresh-selection",
          account_email: "existing@example.com",
        },
      ],
    },
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
  const MicrosoftCalendarManager = loadManagerModule();
  const order = [];
  const manager = new MicrosoftCalendarManager(
    {},
    {
      scheduleNextMeeting: () => order.push("schedule-reminder"),
      reset: () => {},
    }
  );
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
  const MicrosoftCalendarManager = loadManagerModule();
  const databaseManager = {
    clearMicrosoftCalendarData: () => {},
    getMicrosoftAccounts: () => [],
  };
  const manager = new MicrosoftCalendarManager(databaseManager, {
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

test("simultaneous OAuth completions queue their account mutations", async () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const order = [];
  const manager = new MicrosoftCalendarManager(
    {
      getSelectedMicrosoftCalendars: () => [{ id: "cal-1", account_email: "existing@example.com" }],
    },
    { scheduleNextMeeting: () => {}, reset: () => {} }
  );
  let oauthCalls = 0;
  manager.oauth.startOAuthFlow = async ({ shouldPersist }) => {
    assert.equal(shouldPersist(), true);
    oauthCalls++;
    return { success: true, email: `new-${oauthCalls}@example.com` };
  };
  const firstFetchStarted = deferred();
  const releaseFirstFetch = deferred();
  manager.fetchCalendars = async (email) => {
    order.push(`fetch-${email}`);
    if (email === "new-1@example.com") {
      firstFetchStarted.resolve();
      await releaseFirstFetch.promise;
      order.push("first-fetch-end");
    }
  };
  manager._syncCalendar = async () => order.push("event-sync");
  manager.syncRunner.start = () => {};
  manager._broadcastAccountsChanged = () => {};

  const first = manager.startOAuth();
  const second = manager.startOAuth();
  await firstFetchStarted.promise;
  assert.deepEqual(order, ["fetch-new-1@example.com"]);
  releaseFirstFetch.resolve();
  await Promise.all([first, second]);

  assert.deepEqual(order, [
    "fetch-new-1@example.com",
    "first-fetch-end",
    "event-sync",
    "fetch-new-2@example.com",
    "event-sync",
  ]);
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
  assert.equal(mapped.availability_status, "unknown");
  assert.equal(mapped.hangout_link, "https://example.zoom.us/j/123456789");
  assert.equal(mapped.attendees, null);
});

test("_mapEvent normalizes Graph showAs values", () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const manager = new MicrosoftCalendarManager({}, {});
  const baseEvent = {
    id: "evt-availability",
    start: { dateTime: "2026-07-21T09:00:00.0000000" },
    end: { dateTime: "2026-07-21T10:00:00.0000000" },
  };
  const expectedByShowAs = [
    ["free", "free"],
    ["workingElsewhere", "free"],
    ["tentative", "tentative"],
    ["busy", "busy"],
    ["oof", "unavailable"],
    ["unknown", "unknown"],
    [undefined, "unknown"],
  ];

  for (const [showAs, expected] of expectedByShowAs) {
    const mapped = manager._mapEvent(
      { ...baseEvent, showAs },
      { id: "cal-1", account_email: "me@example.com" }
    );
    assert.equal(mapped.availability_status, expected, `showAs=${String(showAs)}`);
  }
});

test("_mapEvent normalizes event-level Graph responseStatus values", () => {
  const MicrosoftCalendarManager = loadManagerModule();
  const manager = new MicrosoftCalendarManager({}, {});
  const baseEvent = {
    id: "evt-response",
    start: { dateTime: "2026-07-21T09:00:00.0000000" },
    end: { dateTime: "2026-07-21T10:00:00.0000000" },
  };
  const expectedByResponse = [
    ["accepted", "accepted"],
    ["declined", "declined"],
    ["tentativelyAccepted", "tentative"],
    ["notResponded", "needsAction"],
    ["organizer", "needsAction"],
  ];

  for (const [response, expected] of expectedByResponse) {
    const mapped = manager._mapEvent(
      { ...baseEvent, responseStatus: { response } },
      { id: "cal-1", account_email: "me@example.com" }
    );
    assert.equal(mapped.self_response_status, expected, `response=${response}`);
  }

  assert.equal(
    manager._mapEvent(baseEvent, { id: "cal-1" }).self_response_status,
    null,
    "a missing event-level response must remain unknown"
  );
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
      showAs: "busy",
      responseStatus: { response: "accepted" },
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
  assert.match(masterFetches[0], /showAs/);
  assert.match(masterFetches[0], /responseStatus/);

  const occurrence = upserted.find((event) => event.id === "occ-1");
  assert.equal(occurrence.summary, "Standup");
  assert.equal(occurrence.start_time, "2026-07-20T09:25:00Z");
  assert.equal(occurrence.availability_status, "busy");
  assert.equal(occurrence.self_response_status, "accepted");
  assert.equal(occurrence.hangout_link, "https://teams.microsoft.com/l/meetup-join/abc");
  assert.equal(occurrence.organizer_email, "organizer@example.com");
  assert.equal(occurrence.attendees_count, 1);
  assert.equal(upserted.find((event) => event.id === "occ-2").summary, "Standup");
  assert.equal(upserted.find((event) => event.id === "evt-1").summary, "One-off");
  assert.ok(contacts.some((contact) => contact.email === "me@example.com"));
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
