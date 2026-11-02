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
  // Reopening runs every later migration too.
  assert.equal(reopened.db.pragma("user_version", { simple: true }), 5);
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

test("Google shared RSVP repair is scoped, preserves notes, and runs once", (t) => {
  const db = createDb(t);
  if (!db) return;
  t.after(() => db.db.open && db.db.close());
  for (const id of ["primary", "shared", "me@example.com"]) {
    db.db
      .prepare(
        `INSERT INTO google_calendars
      (id, summary, is_primary, account_email, sync_token, sync_token_expires_at)
      VALUES (?, ?, ?, 'me@example.com', 'old-google', 9999999999999)`
      )
      .run(id, id, id === "primary" ? 1 : 0);
  }
  insertCalendar(db, "microsoft", "ms");
  db.updateMicrosoftCalendarSyncToken("ms", "old-ms", 9999999999999);
  db.upsertCalendarEvents([
    ...["primary", "shared", "me@example.com", "orphan"].map((id) =>
      restEvent("google", id, id, { self_response_status: "declined" })
    ),
    restEvent("microsoft", "ms", "ms-event", { self_response_status: "declined" }),
    appleEvent("apple-event", { self_response_status: "declined" }),
  ]);
  const note = db.saveNote("Linked meeting", "Keep this note", "meeting").note;
  db.updateNote(note.id, { calendar_event_id: "shared" });
  const before = db.getCalendarEventById("shared");
  db.db.pragma("user_version = 3");
  db.db.close();
  const repaired = new DatabaseManager();
  t.after(() => repaired.db.open && repaired.db.close());
  assert.deepEqual(repaired.getCalendarEventById("shared"), {
    ...before,
    self_response_status: "unknown",
  });
  assert.equal(repaired.getCalendarEventById("orphan").self_response_status, "unknown");
  for (const id of ["primary", "me@example.com", "ms-event", "apple-event"]) {
    assert.equal(repaired.getCalendarEventById(id).self_response_status, "declined");
  }
  // Reopening also runs the v5 lookback reset, which clears every REST token.
  assert.equal(repaired.db.pragma("user_version", { simple: true }), 5);
  const calendars = repaired.getGoogleCalendars();
  assert.equal(calendars.find((c) => c.id === "shared").sync_token, null);
  assert.equal(calendars.find((c) => c.id === "shared").sync_token_expires_at, null);
  assert.equal(calendars.find((c) => c.id === "primary").sync_token, null);
  assert.equal(
    repaired.db.prepare("SELECT sync_token FROM microsoft_calendars WHERE id='ms'").get()
      .sync_token,
    null
  );
  assert.equal(
    repaired.db.prepare("SELECT calendar_event_id FROM notes WHERE id=?").get(note.id)
      .calendar_event_id,
    "shared"
  );
  repaired.upsertCalendarEvents([{ ...before, self_response_status: "accepted" }]);
  repaired.updateCalendarSyncToken("shared", "fresh", 9999999999999);
  repaired.db.close();
  const reopened = new DatabaseManager();
  t.after(() => reopened.db.close());
  assert.equal(reopened.getCalendarEventById("shared").self_response_status, "accepted");
  assert.equal(reopened.getGoogleCalendars().find((c) => c.id === "shared").sync_token, "fresh");
});

test("google: only self-declined schedule rows are hidden, and reacceptance restores them", (t) => {
  const db = createDb(t);
  if (!db) return;
  t.after(() => db.db.close());
  const now = Date.now();
  const make = (id, response, overrides = {}) =>
    restEvent("google", "cal", id, {
      start_time: new Date(now - 5 * 60_000).toISOString(),
      end_time: new Date(now + 30 * 60_000).toISOString(),
      self_response_status: response,
      attendees_count: 2,
      attendees: '[{"self":true,"responseStatus":"accepted"},{"responseStatus":"declined"}]',
      ...overrides,
    });
  const declined = make("declined", "declined", {
    hangout_link: "https://meet.google.com/abc-defg-hij",
  });
  const rows = [
    declined,
    ...["accepted", "tentative", "needsAction", "unknown"].map((response) =>
      make(response, response)
    ),
  ];
  db.upsertCalendarEvents(rows);
  const note = db.saveNote("Declined meeting notes", "Keep", "meeting").note;
  db.updateNote(note.id, { calendar_event_id: "declined" });
  const expected = ["accepted", "needsAction", "tentative", "unknown"];
  for (const events of [db.getUpcomingEvents(60), db.getActiveEvents()]) {
    assert.deepEqual(events.map((e) => e.id).sort(), expected);
  }
  assert.equal(db.getCalendarEventById("declined").hangout_link, declined.hangout_link);
  assert.equal(
    db.db.prepare("SELECT calendar_event_id FROM notes WHERE id=?").get(note.id).calendar_event_id,
    "declined"
  );
  db.upsertCalendarEvents([{ ...declined, self_response_status: "accepted" }]);
  assert.ok(db.getUpcomingEvents(60).some((e) => e.id === "declined"));
  assert.ok(db.getActiveEvents().some((e) => e.id === "declined"));
});

test("declined REST suppresses its stale Apple mirror", (t) => {
  const db = createDb(t);
  if (!db) return;
  t.after(() => db.db.close());
  const now = Date.now();
  const common = {
    summary: "Weekly planning",
    start_time: new Date(now - 5 * 60_000).toISOString(),
    end_time: new Date(now + 30 * 60_000).toISOString(),
  };
  db.upsertCalendarEvents([
    restEvent("google", "cal", "rest-instance", {
      ...common,
      self_response_status: "declined",
    }),
    appleEvent("apple-instance", { ...common, self_response_status: "accepted" }),
  ]);
  assert.deepEqual(db.getUpcomingEvents(120), []);
  assert.deepEqual(db.getActiveEvents(), []);
});

test("reopening a pre-v5 database clears REST sync tokens once", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertCalendar(db, "google", "google-calendar");
  insertCalendar(db, "microsoft", "ms-calendar");
  const seedTokens = (target) => {
    target.updateCalendarSyncToken("google-calendar", "sync-token", Date.now() + 1000000);
    target.updateMicrosoftCalendarSyncToken("ms-calendar", "delta-link", Date.now() + 1000000);
  };
  const tokens = (target) => [
    target.db.prepare("SELECT sync_token FROM google_calendars").get().sync_token,
    target.db.prepare("SELECT sync_token FROM microsoft_calendars").get().sync_token,
  ];
  seedTokens(db);
  db.db.pragma("user_version = 4");
  db.db.close();

  const reopened = new DatabaseManager();
  assert.deepEqual(tokens(reopened), [null, null]);
  seedTokens(reopened);
  reopened.db.close();

  const again = new DatabaseManager();
  assert.deepEqual(tokens(again), ["sync-token", "delta-link"]);
  again.db.close();
});

test("events from two and three days ago never surface as active, upcoming or available", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertCalendar(db, "google", "google-calendar");
  const now = Date.now();
  const twoDaysAgo = new Date(now - 2 * 86_400_000);
  const localDate = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  db.upsertCalendarEvents([
    restEvent("google", "google-calendar", "past-timed", {
      start_time: new Date(now - 50 * 3_600_000).toISOString(),
      end_time: new Date(now - 49 * 3_600_000).toISOString(),
    }),
    restEvent("google", "google-calendar", "past-all-day", {
      start_time: localDate(twoDaysAgo),
      end_time: localDate(new Date(twoDaysAgo.getTime() + 86_400_000)),
      is_all_day: true,
    }),
  ]);
  const pastIds = new Set(["past-timed", "past-all-day"]);
  const ids = (events) => events.map((event) => event.id).filter((id) => pastIds.has(id));

  assert.deepEqual(ids(db.getActiveEvents()), []);
  assert.deepEqual(ids(db.getUpcomingEvents(1440)), []);
  assert.deepEqual(
    ids(
      db.getCalendarEventsInRange(
        new Date(now).toISOString(),
        new Date(now + 86_400_000).toISOString(),
        ["google"]
      )
    ),
    []
  );
  db.db.close();
});

function insertAppleCalendar(db, id, color = null) {
  db.db
    .prepare("INSERT INTO apple_calendars (id, title, color) VALUES (?, ?, ?)")
    .run(id, id, color);
}

test("linkable events cover selected calendars and skip cancelled and declined ones", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertCalendar(db, "google", "google-calendar");
  insertCalendar(db, "google", "hidden-google", 0);
  insertCalendar(db, "microsoft", "ms-calendar");
  db.upsertCalendarEvents([
    restEvent("google", "google-calendar", "tentative", {
      start_time: "2026-07-22T12:00:00Z",
      end_time: "2026-07-22T13:00:00Z",
      status: "tentative",
    }),
    restEvent("google", "google-calendar", "confirmed"),
    restEvent("microsoft", "ms-calendar", "cancelled", { status: "cancelled" }),
    restEvent("google", "google-calendar", "declined", { self_response_status: "declined" }),
    restEvent("google", "hidden-google", "hidden"),
  ]);

  assert.deepEqual(
    db.getLinkableCalendarEvents().map((event) => event.id),
    ["confirmed", "tentative"]
  );
  db.db.close();
});

test("a declined REST event keeps its Apple mirror out of the linkable list", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertCalendar(db, "google", "google-calendar");
  insertAppleCalendar(db, "apple-calendar");
  db.upsertCalendarEvents([
    restEvent("google", "google-calendar", "declined", {
      summary: "Standup",
      self_response_status: "declined",
    }),
    appleEvent("mirror", {
      summary: "Standup",
      start_time: "2026-07-22T10:00:00Z",
      end_time: "2026-07-22T11:00:00Z",
    }),
  ]);

  assert.deepEqual(db.getLinkableCalendarEvents(), []);
  db.db.close();
});

test("linkable events carry their calendar's colour only when it is a hex colour", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertCalendar(db, "google", "google-calendar");
  insertCalendar(db, "microsoft", "ms-calendar");
  insertAppleCalendar(db, "apple-calendar", "#FF0000");
  db.db.prepare("UPDATE google_calendars SET background_color = '#1A73E8'").run();
  db.db.prepare("UPDATE microsoft_calendars SET background_color = 'auto'").run();
  db.upsertCalendarEvents([
    restEvent("google", "google-calendar", "google-event"),
    restEvent("microsoft", "ms-calendar", "ms-event", { summary: "Other" }),
    appleEvent("apple-event"),
  ]);

  const colors = Object.fromEntries(
    db.getLinkableCalendarEvents().map((event) => [event.id, event.calendar_color])
  );
  assert.deepEqual(colors, {
    "apple-event": "#FF0000",
    "google-event": "#1A73E8",
    "ms-event": null,
  });
  db.db.close();
});

test("linkable events include all-day rows and recent past events", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertCalendar(db, "google", "google-calendar");
  const twoDaysAgo = Date.now() - 2 * 86_400_000;
  db.upsertCalendarEvents([
    restEvent("google", "google-calendar", "all-day", {
      start_time: "2026-07-22",
      end_time: "2026-07-23",
      is_all_day: true,
    }),
    restEvent("google", "google-calendar", "two-days-ago", {
      start_time: new Date(twoDaysAgo).toISOString(),
      end_time: new Date(twoDaysAgo + 3_600_000).toISOString(),
    }),
  ]);

  assert.deepEqual(
    db
      .getLinkableCalendarEvents()
      .map((event) => event.id)
      .sort(),
    ["all-day", "two-days-ago"]
  );
  db.db.close();
});

test("linkable events leave out old rows kept only for the notes that link them", (t) => {
  const db = createDb(t);
  if (!db) return;
  insertCalendar(db, "google", "google-calendar");
  const at = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  db.upsertCalendarEvents([
    restEvent("google", "google-calendar", "recent", { start_time: at(2), end_time: at(1.9) }),
    restEvent("google", "google-calendar", "old-linked", {
      start_time: at(30),
      end_time: at(29.9),
    }),
  ]);
  const note = db.saveNote("Old meeting", "", "meeting").note;
  db.updateNote(note.id, { calendar_event_id: "old-linked" });

  assert.deepEqual(
    db.getLinkableCalendarEvents({ endsAfter: at(4) }).map((event) => event.id),
    ["recent"]
  );
  assert.equal(db.getCalendarEventById("old-linked")?.id, "old-linked", "the row itself stays");
  db.db.close();
});

test("web_link round-trips through upsertCalendarEvents", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.upsertCalendarEvents([
    restEvent("google", "google-calendar", "linked", { web_link: "https://calendar.google.com/x" }),
    appleEvent("apple"),
  ]);

  assert.equal(db.getCalendarEventById("linked").web_link, "https://calendar.google.com/x");
  assert.equal(db.getCalendarEventById("apple").web_link, null);
  db.db.close();
});

// SQLite reads local dates through libc, which follows process.env.TZ, so a
// non-UTC zone exercises what CI (TZ=UTC) would otherwise hide.
function useTimeZone(t, zone) {
  const original = process.env.TZ;
  process.env.TZ = zone;
  t.after(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });
}

// The Apple helper writes an all-day start as local midnight in UTC form.
const appleAllDayInstant = (year, month, day) =>
  new Date(year, month, day).toISOString().replace(".000Z", "Z");

test("an all-day event and its Calendar.app copy collapse outside UTC", (t) => {
  useTimeZone(t, "America/Los_Angeles");
  const db = createDb(t);
  if (!db) return;
  insertCalendar(db, "google", "google-calendar");
  insertAppleCalendar(db, "apple-calendar");
  db.upsertCalendarEvents([
    restEvent("google", "google-calendar", "google-offsite", {
      summary: "Offsite",
      start_time: "2026-10-20",
      end_time: "2026-10-21",
      is_all_day: true,
    }),
    appleEvent("apple-offsite", {
      summary: "Offsite",
      start_time: appleAllDayInstant(2026, 9, 20),
      end_time: appleAllDayInstant(2026, 9, 21),
      is_all_day: true,
    }),
    appleEvent("apple-holiday", {
      summary: "Holiday",
      start_time: appleAllDayInstant(2026, 9, 20),
      end_time: appleAllDayInstant(2026, 9, 21),
      is_all_day: true,
    }),
  ]);

  assert.deepEqual(
    db
      .getLinkableCalendarEvents()
      .map((event) => event.id)
      .sort(),
    ["apple-holiday", "google-offsite"]
  );
  db.db.close();
});

test("a declined all-day event keeps its Calendar.app copy out outside UTC", (t) => {
  useTimeZone(t, "Asia/Kolkata");
  const db = createDb(t);
  if (!db) return;
  insertCalendar(db, "google", "google-calendar");
  insertAppleCalendar(db, "apple-calendar");
  db.upsertCalendarEvents([
    restEvent("google", "google-calendar", "google-offsite", {
      summary: "Offsite",
      start_time: "2026-10-20",
      end_time: "2026-10-21",
      is_all_day: true,
      self_response_status: "declined",
    }),
    appleEvent("apple-offsite", {
      summary: "Offsite",
      start_time: appleAllDayInstant(2026, 9, 20),
      end_time: appleAllDayInstant(2026, 9, 21),
      is_all_day: true,
    }),
  ]);

  assert.deepEqual(db.getLinkableCalendarEvents(), []);
  db.db.close();
});

test("all-day mirrors pair whichever end EventKit reports, and a longer namesake stays", (t) => {
  useTimeZone(t, "America/Los_Angeles");
  const db = createDb(t);
  if (!db) return;
  insertCalendar(db, "google", "google-calendar");
  insertAppleCalendar(db, "apple-calendar");
  const lastSecond = (year, month, day) =>
    new Date(year, month, day, 23, 59, 59).toISOString().replace(".000Z", "Z");
  db.upsertCalendarEvents([
    restEvent("google", "google-calendar", "google-offsite", {
      summary: "Offsite",
      start_time: "2026-10-20",
      end_time: "2026-10-21",
      is_all_day: true,
    }),
    // The mirror ends on the event's last second rather than the next midnight.
    appleEvent("apple-offsite", {
      summary: "Offsite",
      start_time: appleAllDayInstant(2026, 9, 20),
      end_time: lastSecond(2026, 9, 20),
      is_all_day: true,
    }),
    restEvent("google", "google-calendar", "google-vacation", {
      summary: "Vacation",
      start_time: "2026-10-20",
      end_time: "2026-10-21",
      is_all_day: true,
    }),
    // A separate, longer event on the user's own calendar, not a mirror.
    appleEvent("apple-vacation-4d", {
      summary: "Vacation",
      start_time: appleAllDayInstant(2026, 9, 20),
      end_time: appleAllDayInstant(2026, 9, 24),
      is_all_day: true,
    }),
  ]);

  assert.deepEqual(
    db
      .getLinkableCalendarEvents()
      .map((event) => event.id)
      .sort(),
    ["apple-vacation-4d", "google-offsite", "google-vacation"]
  );
  db.db.close();
});
