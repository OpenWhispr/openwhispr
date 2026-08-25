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

test("copied Apple rows never expose the provider as connected off macOS", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    const AppleCalendarManager = loadManager();
    const manager = new AppleCalendarManager(
      { getAppleCalendars: () => [{ id: "calendar-1", source_name: "iCloud" }] },
      {}
    );

    assert.equal(manager.isConnected(), false);
    assert.deepEqual(manager.getConnectionStatus(), { connected: false, sourceNames: [] });
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
    availability: "busy",
    location: "Zoom: https://example.zoom.us/j/123456789",
    notes_urls: [],
    attendees: [],
  });

  assert.equal(mapped.provider, "apple");
  assert.equal(mapped.availability_status, "busy");
  assert.equal(mapped.hangout_link, "https://example.zoom.us/j/123456789");
  assert.equal(mapped.attendees_count, 0);
  assert.equal(mapped.attendees, null);
});

test("_mapEvent accepts normalized availability and defaults unknown values conservatively", () => {
  const AppleCalendarManager = loadManager();
  const manager = new AppleCalendarManager({}, {});
  const baseEvent = {
    id: "evt-availability:1755165600",
    calendar_id: "calendar-1",
    start: "2026-08-14T10:00:00Z",
    end: "2026-08-14T10:30:00Z",
    is_all_day: false,
    status: "confirmed",
    attendees: [],
  };

  for (const availability of ["free", "tentative", "busy", "unavailable", "unknown"]) {
    assert.equal(
      manager._mapEvent({ ...baseEvent, availability }).availability_status,
      availability
    );
  }
  assert.equal(
    manager._mapEvent({ ...baseEvent, availability: "unexpected" }).availability_status,
    "unknown"
  );
  assert.equal(manager._mapEvent(baseEvent).availability_status, "unknown");
});

test("_mapEvent records the current user's response independently of attendees", () => {
  const AppleCalendarManager = loadManager();
  const manager = new AppleCalendarManager({}, {});
  const mapped = manager._mapEvent({
    id: "evt-response:1755165600",
    calendar_id: "calendar-1",
    start: "2026-08-14T10:00:00Z",
    end: "2026-08-14T10:30:00Z",
    is_all_day: false,
    status: "confirmed",
    availability: "busy",
    attendees: [
      { email: "other@example.com", status: "accepted", self: false },
      { email: "me@example.com", status: "declined", self: true },
    ],
  });

  assert.equal(mapped.self_response_status, "declined");
});

test("availability refreshes coalesce and resolve only after a fresh snapshot", async () => {
  const AppleCalendarManager = loadManager();
  const writes = [];
  const databaseManager = {
    getAppleCalendars: () => [{ id: "calendar-1" }],
    saveAppleCalendars: () => {},
    replaceAppleCalendarEvents: () => {},
    upsertContacts: () => {},
  };
  const reminderScheduler = {
    reconcileProvider: () => {},
    scheduleNextMeeting: () => {},
  };
  const manager = new AppleCalendarManager(databaseManager, reminderScheduler);
  manager.isConnected = () => true;
  manager._helperProcess = { stdin: { write: (value) => writes.push(value) } };

  const first = manager.refreshAvailability();
  const second = manager.refreshAvailability();
  assert.equal(first, second);
  assert.deepEqual(writes, ["sync\n"]);

  manager._applySnapshot({ calendars: [{ id: "calendar-1" }], events: [] });
  await Promise.all([first, second]);
  assert.equal(manager._pendingAvailabilityRefresh, null);

  await manager.refreshAvailability();
  assert.deepEqual(writes, ["sync\n"], "a recent successful snapshot should be reused");

  manager._lastSuccessfulSnapshotAt = Date.now() + 60_000;
  const afterClockRollback = manager.refreshAvailability();
  assert.deepEqual(writes, ["sync\n", "sync\n"]);
  manager._applySnapshot({ calendars: [{ id: "calendar-1" }], events: [] });
  await afterClockRollback;
});

test("availability refresh fails closed when the helper exits", async () => {
  const AppleCalendarManager = loadManager();
  const manager = new AppleCalendarManager({ getAppleCalendars: () => [{ id: "calendar-1" }] }, {});
  manager.isConnected = () => true;
  const child = { stdin: { write: () => {} } };
  manager._helperProcess = child;
  manager._scheduleHelperRestart = () => {};

  const refresh = manager.refreshAvailability();
  manager._onHelperGone(child);

  await assert.rejects(refresh, /helper exited/);
});

test("an empty snapshot broadcasts that Apple Calendar disconnected", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const AppleCalendarManager = loadManager();
    let calendars = [{ id: "calendar-1", source_name: "iCloud" }];
    const databaseManager = {
      getAppleCalendars: () => calendars,
      saveAppleCalendars: (nextCalendars) => {
        calendars = nextCalendars;
      },
      replaceAppleCalendarEvents: () => {},
      upsertContacts: () => {},
    };
    const reminderScheduler = {
      reconcileProvider: () => {},
      scheduleNextMeeting: () => {},
    };
    const manager = new AppleCalendarManager(databaseManager, reminderScheduler);
    let connectionBroadcasts = 0;
    manager._broadcastConnectionChanged = () => {
      connectionBroadcasts += 1;
    };

    manager._applySnapshot({ calendars: [], events: [] });

    assert.equal(manager.isConnected(), false);
    assert.equal(connectionBroadcasts, 1);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

test("an empty first snapshot cannot report a successful Apple connection", async () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const AppleCalendarManager = loadManager();
    let calendars = [];
    const databaseManager = {
      getAppleCalendars: () => calendars,
      saveAppleCalendars: (nextCalendars) => {
        calendars = nextCalendars;
      },
      replaceAppleCalendarEvents: () => {},
      upsertContacts: () => {},
    };
    const reminderScheduler = {
      reconcileProvider: () => {},
      scheduleNextMeeting: () => {},
    };
    const manager = new AppleCalendarManager(databaseManager, reminderScheduler);
    let resolveConnect;
    const connectResult = new Promise((resolve) => {
      resolveConnect = resolve;
    });
    manager._pendingConnect = { resolve: resolveConnect, awaitingSnapshot: true };
    manager._broadcastConnectionChanged = () => {};

    manager._applySnapshot({ calendars: [], events: [] });

    assert.deepEqual(await connectResult, { success: false, reason: "snapshot-failed" });
    assert.equal(manager.isConnected(), false);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

test("buffered output from a stopped helper cannot repopulate calendar data", () => {
  const AppleCalendarManager = loadManager();
  let messages = 0;
  const manager = new AppleCalendarManager({}, {});
  const child = {};
  const state = { buffer: "" };
  manager._helperProcess = child;
  manager._handleMessage = () => {
    messages += 1;
  };

  manager._handleHelperOutput(child, state, Buffer.from('{"type":"snapshot"}\n'));
  assert.equal(messages, 1);

  manager._helperProcess = null;
  manager._handleHelperOutput(child, state, Buffer.from('{"type":"snapshot"}\n'));
  assert.equal(messages, 1);
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
