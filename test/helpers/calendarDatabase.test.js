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

function restEvent(provider, calendarId, id, overrides = {}) {
  return {
    id,
    calendar_id: calendarId,
    provider,
    summary: id,
    start_time: "2026-07-22T10:00:00Z",
    end_time: "2026-07-22T11:00:00Z",
    is_all_day: false,
    status: "confirmed",
    ...overrides,
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

function insertCalendar(db, provider, id, selected = 1) {
  const table = provider === "google" ? "google_calendars" : "microsoft_calendars";
  db.db
    .prepare(
      `INSERT INTO ${table} (id, summary, is_selected, is_primary, account_email) VALUES (?, ?, ?, 1, ?)`
    )
    .run(id, id, selected, `${provider}@example.com`);
}

test("calendar availability fields are persisted with events", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertCalendarEvents([
    restEvent("google", "google-calendar", "free-declined", {
      availability_status: "free",
      self_response_status: "declined",
    }),
  ]);

  const event = db.getCalendarEventById("free-declined");
  assert.equal(event.availability_status, "free");
  assert.equal(event.self_response_status, "declined");
  db.db.close();
});

test("availability range query uses overlap boundaries and selected calendars", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertCalendar(db, "google", "selected-google");
  insertCalendar(db, "google", "hidden-google", 0);
  insertCalendar(db, "microsoft", "selected-microsoft");

  db.upsertCalendarEvents([
    restEvent("google", "selected-google", "ends-at-start", {
      start_time: "2026-07-22T09:00:00Z",
      end_time: "2026-07-22T10:00:00Z",
    }),
    restEvent("google", "selected-google", "overlaps", {
      start_time: "2026-07-22T09:30:00Z",
      end_time: "2026-07-22T10:30:00Z",
    }),
    restEvent("google", "hidden-google", "deselected", {
      start_time: "2026-07-22T10:15:00Z",
      end_time: "2026-07-22T10:45:00Z",
    }),
    restEvent("microsoft", "selected-microsoft", "other-provider", {
      start_time: "2026-07-22T10:15:00Z",
      end_time: "2026-07-22T10:45:00Z",
    }),
  ]);

  const events = db.getCalendarEventsInRange("2026-07-22T10:00:00Z", "2026-07-22T11:00:00Z", [
    "google",
  ]);
  assert.deepEqual(
    events.map((event) => event.id),
    ["overlaps"]
  );
  db.db.close();
});

test("availability range query treats date-only all-day events as local dates", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.db
    .prepare("INSERT INTO apple_calendars (id, title) VALUES (?, ?)")
    .run("apple-calendar", "Apple");
  db.upsertCalendarEvents([
    appleEvent("all-day", {
      start_time: "2026-07-22",
      end_time: "2026-07-23",
      is_all_day: true,
    }),
  ]);

  const events = db.getCalendarEventsInRange(
    new Date(2026, 6, 22, 9).toISOString(),
    new Date(2026, 6, 22, 18).toISOString(),
    ["apple"]
  );
  assert.deepEqual(
    events.map((event) => event.id),
    ["all-day"]
  );
  db.db.close();
});

test("reopening a pre-v2 database clears microsoft sync tokens once", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertCalendar(db, "microsoft", "ms-calendar");
  db.updateMicrosoftCalendarSyncToken("ms-calendar", "delta-link", Date.now() + 1000000);
  db.db.pragma("user_version = 1");
  db.db.close();

  const reopened = new DatabaseManager();
  const calendar = reopened.db
    .prepare("SELECT * FROM microsoft_calendars WHERE id = 'ms-calendar'")
    .get();
  assert.equal(calendar.sync_token, null);
  assert.equal(calendar.sync_token_expires_at, null);
  assert.equal(reopened.db.pragma("user_version", { simple: true }), 2);
  reopened.db.close();
});

test("google sync token persists alongside its expiry", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertCalendar(db, "google", "google-calendar");

  const expiresAt = Date.parse("2026-07-23T10:00:00Z");
  db.updateCalendarSyncToken("google-calendar", "sync-token", expiresAt);

  const calendar = db.getGoogleCalendars().find((row) => row.id === "google-calendar");
  assert.equal(calendar.sync_token, "sync-token");
  assert.equal(calendar.sync_token_expires_at, expiresAt);
  db.db.close();
});
