const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-calendar-db-"));
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => userDataDir,
        getAppPath: () => process.cwd(),
        isReady: () => false,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.NODE_ENV = "test";

const DatabaseManager = require("../../src/helpers/database.js");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-calendar-db-"));
  try {
    return new DatabaseManager();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

function appleEvent(id, overrides = {}) {
  return {
    id,
    calendar_id: "apple-calendar",
    provider: "apple",
    summary: id,
    start_time: "2026-07-20T10:00:00Z",
    end_time: "2026-07-20T11:00:00Z",
    is_all_day: false,
    status: "confirmed",
    ...overrides,
  };
}

test("Apple snapshots retain events referenced by meeting notes", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertCalendarEvents([appleEvent("linked-event"), appleEvent("unlinked-event")]);
  const note = db.saveNote("Linked meeting", "", "meeting").note;
  db.updateNote(note.id, { calendar_event_id: "linked-event" });

  db.replaceAppleCalendarEvents([]);

  assert.equal(db.getCalendarEventById("linked-event")?.summary, "linked-event");
  assert.equal(db.getCalendarEventById("unlinked-event"), null);
  db.db.close();
});

function restEvent(provider, calendarId, id) {
  return {
    id,
    calendar_id: calendarId,
    provider,
    summary: id,
    start_time: "2026-07-22T10:00:00Z",
    end_time: "2026-07-22T11:00:00Z",
    is_all_day: false,
    status: "confirmed",
  };
}

test("full-sync prune drops stale events but keeps fresh, note-linked, and other-scope rows", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertCalendarEvents([
    restEvent("microsoft", "ms-cal", "fresh"),
    restEvent("microsoft", "ms-cal", "stale"),
    restEvent("microsoft", "ms-cal", "stale-linked"),
    restEvent("microsoft", "other-cal", "other-calendar"),
    restEvent("google", "ms-cal", "other-provider"),
  ]);
  const note = db.saveNote("Linked meeting", "", "meeting").note;
  db.updateNote(note.id, { calendar_event_id: "stale-linked" });

  db.removeStaleCalendarEvents("microsoft", "ms-cal", ["fresh"]);

  assert.equal(db.getCalendarEventById("fresh")?.summary, "fresh");
  assert.equal(db.getCalendarEventById("stale"), null);
  assert.equal(db.getCalendarEventById("stale-linked")?.summary, "stale-linked");
  assert.equal(db.getCalendarEventById("other-calendar")?.summary, "other-calendar");
  assert.equal(db.getCalendarEventById("other-provider")?.summary, "other-provider");
  db.db.close();
});

test("full-sync prune with an empty fresh set clears the calendar's unlinked events", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertCalendarEvents([restEvent("microsoft", "ms-cal", "stale")]);

  db.removeStaleCalendarEvents("microsoft", "ms-cal", []);

  assert.equal(db.getCalendarEventById("stale"), null);
  db.db.close();
});

test("tentative Apple events remain visible in upcoming meetings", (t) => {
  const db = createDb(t);
  if (!db) return;

  const now = Date.now();
  db.upsertCalendarEvents([
    appleEvent("tentative-event", {
      start_time: new Date(now + 5 * 60_000).toISOString(),
      end_time: new Date(now + 35 * 60_000).toISOString(),
      status: "tentative",
    }),
  ]);

  const events = db.getUpcomingEvents(15);
  assert.equal(
    events.some((event) => event.id === "tentative-event"),
    true
  );
  db.db.close();
});

test("getEventsInRange returns overlapping rows, including all-day, and excludes cancelled", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertCalendarEvents([
    restEvent("google", "g-cal", "inside"),
    {
      ...restEvent("google", "g-cal", "day-before"),
      start_time: "2026-07-21T08:00:00Z",
      end_time: "2026-07-21T09:00:00Z",
    },
    {
      ...restEvent("google", "g-cal", "spans-range-start"),
      start_time: "2026-07-22T08:00:00Z",
      end_time: "2026-07-22T10:30:00Z",
    },
    { ...restEvent("google", "g-cal", "cancelled"), status: "cancelled" },
    {
      ...restEvent("google", "g-cal", "all-day"),
      start_time: "2026-07-22",
      end_time: "2026-07-23",
      is_all_day: true,
    },
  ]);

  const events = db.getEventsInRange("2026-07-22T09:00:00Z", "2026-07-23T00:00:00Z");

  assert.deepEqual(
    events.map((e) => e.id),
    ["all-day", "spans-range-start", "inside"]
  );
  assert.equal("has_synced" in events[0], false);
  db.db.close();
});

test("getEventsInRange collapses the Apple mirror of a REST event", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertCalendarEvents([
    restEvent("google", "g-cal", "team-sync"),
    appleEvent("apple-mirror", {
      summary: "team-sync",
      start_time: "2026-07-22T10:00:00Z",
      end_time: "2026-07-22T11:00:00Z",
    }),
    appleEvent("apple-only", {
      start_time: "2026-07-22T14:00:00Z",
      end_time: "2026-07-22T15:00:00Z",
    }),
  ]);

  const events = db.getEventsInRange("2026-07-22T00:00:00Z", "2026-07-23T00:00:00Z");

  assert.deepEqual(
    events.map((e) => e.id),
    ["team-sync", "apple-only"]
  );
  db.db.close();
});

test("the sync-token reset migration does not re-run once user_version is stamped", (t) => {
  const db = createDb(t);
  if (!db) return;

  assert.equal(db.db.pragma("user_version", { simple: true }), 2);
  db.db
    .prepare(
      "INSERT INTO google_calendars (id, summary, sync_token, account_email) VALUES ('cal', 'Cal', 'token', 'a@b.c')"
    )
    .run();

  const reopened = new DatabaseManager();
  assert.equal(
    reopened.db.prepare("SELECT sync_token FROM google_calendars WHERE id = 'cal'").get()
      .sync_token,
    "token"
  );
  reopened.db.close();
  db.db.close();
});
