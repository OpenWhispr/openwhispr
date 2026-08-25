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

test("calendar semantics migration adds provider state and forces a full resync", (t) => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-calendar-db-"));
  let LegacyDatabase;
  try {
    LegacyDatabase = require("better-sqlite3");
    const legacy = new LegacyDatabase(path.join(userDataDir, "transcriptions.db"));
    legacy.exec(`
      CREATE TABLE google_calendars (
        id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        description TEXT,
        background_color TEXT,
        is_selected INTEGER NOT NULL DEFAULT 1,
        sync_token TEXT,
        account_email TEXT,
        is_primary INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE microsoft_calendars (
        id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        background_color TEXT,
        is_selected INTEGER NOT NULL DEFAULT 1,
        is_primary INTEGER NOT NULL DEFAULT 0,
        sync_token TEXT,
        sync_token_expires_at INTEGER,
        account_email TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE calendar_events (
        id TEXT PRIMARY KEY,
        calendar_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'google',
        summary TEXT,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        is_all_day INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'confirmed',
        hangout_link TEXT,
        conference_data TEXT,
        organizer_email TEXT,
        attendees_count INTEGER DEFAULT 0,
        attendees TEXT,
        synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO google_calendars (id, summary, sync_token)
        VALUES ('google-cal', 'Google', 'google-token');
      INSERT INTO microsoft_calendars (id, summary, sync_token, sync_token_expires_at)
        VALUES ('microsoft-cal', 'Microsoft', 'microsoft-token', 9999999999999);
      INSERT INTO calendar_events (id, calendar_id, start_time, end_time)
        VALUES ('legacy-event', 'google-cal', '2026-08-25T10:00:00Z', '2026-08-25T11:00:00Z');
    `);
    legacy.close();
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return;
    }
    throw error;
  }

  const db = new DatabaseManager();
  assert.ok(
    db.db
      .prepare("PRAGMA table_info(calendar_events)")
      .all()
      .some(({ name }) => name === "availability_status")
  );
  assert.ok(
    db.db
      .prepare("PRAGMA table_info(calendar_events)")
      .all()
      .some(({ name }) => name === "self_response_status")
  );
  assert.ok(
    db.db
      .prepare("PRAGMA table_info(google_calendars)")
      .all()
      .some(({ name }) => name === "sync_token_expires_at")
  );
  assert.deepEqual(
    db.db.prepare("SELECT sync_token, sync_token_expires_at FROM google_calendars").get(),
    { sync_token: null, sync_token_expires_at: null }
  );
  assert.deepEqual(
    db.db.prepare("SELECT sync_token, sync_token_expires_at FROM microsoft_calendars").get(),
    { sync_token: null, sync_token_expires_at: null }
  );
  assert.equal(
    db.db.prepare("SELECT availability_status FROM calendar_events").get().availability_status,
    "unknown"
  );
  assert.equal(
    db.db.prepare("SELECT self_response_status FROM calendar_events").get().self_response_status,
    "unknown"
  );
  db.db.close();
});

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

test("token refresh updates cannot recreate or overwrite a disconnected account", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.saveGoogleTokens({
    google_email: "google@example.com",
    access_token: "old-google-access",
    refresh_token: "old-google-refresh",
    expires_at: 1,
    scope: "calendar",
  });
  db.saveMicrosoftTokens({
    microsoft_email: "microsoft@example.com",
    access_token: "old-microsoft-access",
    refresh_token: "old-microsoft-refresh",
    expires_at: 1,
    scope: "calendar",
  });

  assert.equal(
    db.updateGoogleTokensAfterRefresh(
      {
        google_email: "google@example.com",
        access_token: "wrong-google-access",
        refresh_token: "old-google-refresh",
        expires_at: 2,
        scope: "calendar",
      },
      "different-refresh-token"
    ).success,
    false
  );
  assert.equal(
    db.updateMicrosoftTokensAfterRefresh(
      {
        microsoft_email: "microsoft@example.com",
        access_token: "new-microsoft-access",
        refresh_token: "new-microsoft-refresh",
        expires_at: 2,
        scope: "calendar",
      },
      "old-microsoft-refresh"
    ).success,
    true
  );
  assert.equal(db.getGoogleTokensByEmail("google@example.com").access_token, "old-google-access");
  assert.equal(
    db.getMicrosoftTokensByEmail("microsoft@example.com").refresh_token,
    "new-microsoft-refresh"
  );

  db.removeGoogleAccount("google@example.com");
  assert.equal(
    db.updateGoogleTokensAfterRefresh(
      {
        google_email: "google@example.com",
        access_token: "late-google-access",
        refresh_token: "old-google-refresh",
        expires_at: 3,
        scope: "calendar",
      },
      "old-google-refresh"
    ).success,
    false
  );
  assert.equal(db.getGoogleTokensByEmail("google@example.com"), null);
  db.removeMicrosoftAccount("microsoft@example.com");
  assert.equal(
    db.updateMicrosoftTokensAfterRefresh(
      {
        microsoft_email: "microsoft@example.com",
        access_token: "late-microsoft-access",
        refresh_token: "late-microsoft-refresh",
        expires_at: 3,
        scope: "calendar",
      },
      "new-microsoft-refresh"
    ).success,
    false
  );
  assert.equal(db.getMicrosoftTokensByEmail("microsoft@example.com"), null);
  db.db.close();
});

test("Apple snapshots retain events referenced by meeting notes", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertCalendarEvents([appleEvent("linked-event"), appleEvent("unlinked-event")]);
  const note = db.saveNote("Linked meeting", "", "meeting").note;
  db.updateNote(note.id, { calendar_event_id: "linked-event" });

  db.replaceAppleCalendarEvents([]);

  assert.equal(db.getCalendarEventById("linked-event")?.summary, "linked-event");
  assert.equal(db.getCalendarEventById("linked-event")?.status, "cancelled");
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

function registerProviderCalendars(db, { google = [], microsoft = [], apple = [] }) {
  if (google.length > 0) {
    db.saveGoogleCalendars(
      google.map((id) => ({ id, summary: id, is_primary: false })),
      "google@example.com"
    );
  }
  if (microsoft.length > 0) {
    db.saveMicrosoftCalendars(
      microsoft.map((id) => ({ id, summary: id, is_primary: false })),
      "microsoft@example.com"
    );
  }
  if (apple.length > 0) {
    db.saveAppleCalendars(apple.map((id) => ({ id, title: id })));
  }
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
  assert.equal(db.getCalendarEventById("stale-linked")?.status, "cancelled");
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

test("provider deletions retain note metadata as cancelled without leaving active rows", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertCalendarEvents([
    restEvent("google", "calendar", "linked-deletion"),
    restEvent("google", "calendar", "unlinked-deletion"),
  ]);
  const note = db.saveNote("Deleted meeting", "", "meeting").note;
  db.updateNote(note.id, { calendar_event_id: "linked-deletion" });

  db.removeCalendarEvents(["linked-deletion", "unlinked-deletion"]);

  assert.equal(db.getCalendarEventById("linked-deletion")?.status, "cancelled");
  assert.equal(db.getCalendarEventById("unlinked-deletion"), null);
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

test("calendar range queries use half-open overlap semantics and include all-day events", (t) => {
  const db = createDb(t);
  if (!db) return;

  registerProviderCalendars(db, { google: ["cal"], microsoft: ["cal"], apple: ["cal"] });

  db.upsertCalendarEvents([
    restEvent("google", "cal", "ends-at-start", {
      start_time: "2026-07-22T08:00:00Z",
      end_time: "2026-07-22T09:00:00Z",
    }),
    restEvent("google", "cal", "overlaps-start", {
      start_time: "2026-07-22T08:30:00Z",
      end_time: "2026-07-22T09:30:00Z",
    }),
    restEvent("microsoft", "cal", "inside", {
      start_time: "2026-07-22T10:00:00Z",
      end_time: "2026-07-22T11:00:00Z",
      availability_status: "free",
    }),
    restEvent("apple", "cal", "all-day", {
      start_time: "2026-07-22",
      end_time: "2026-07-23",
      is_all_day: true,
      availability_status: "unavailable",
    }),
    restEvent("google", "cal", "cancelled", {
      start_time: "2026-07-22T11:00:00Z",
      end_time: "2026-07-22T12:00:00Z",
      status: "cancelled",
    }),
    restEvent("google", "cal", "starts-at-end", {
      start_time: "2026-07-22T17:00:00Z",
      end_time: "2026-07-22T18:00:00Z",
    }),
  ]);

  const events = db.getCalendarEventsInRange("2026-07-22T09:00:00Z", "2026-07-22T17:00:00Z");

  assert.deepEqual(events.map((event) => event.id).sort(), ["all-day", "inside", "overlaps-start"]);
  assert.equal(events.find((event) => event.id === "inside").availability_status, "free");
  db.db.close();
});

test("date-only all-day events use device-local day boundaries", (t) => {
  const db = createDb(t);
  if (!db) return;

  registerProviderCalendars(db, { google: ["cal"] });

  db.upsertCalendarEvents([
    restEvent("google", "cal", "local-all-day", {
      start_time: "2026-07-23",
      end_time: "2026-07-24",
      is_all_day: true,
    }),
  ]);

  const originalTimeZone = process.env.TZ;
  try {
    for (const timeZone of ["Asia/Kolkata", "America/Los_Angeles"]) {
      process.env.TZ = timeZone;
      const localRange = (hour) => [
        new Date(2026, 6, 23, hour, 30).toISOString(),
        new Date(2026, 6, 23, hour, 45).toISOString(),
      ];
      const [earlyStart, earlyEnd] = localRange(0);
      const [lateStart, lateEnd] = localRange(23);

      assert.deepEqual(
        db.getCalendarEventsInRange(earlyStart, earlyEnd).map((event) => event.id),
        ["local-all-day"]
      );
      assert.deepEqual(
        db.getCalendarEventsInRange(lateStart, lateEnd).map((event) => event.id),
        ["local-all-day"]
      );
      assert.deepEqual(
        db
          .getCalendarEventsInRange(
            new Date(2026, 6, 24, 0, 0).toISOString(),
            new Date(2026, 6, 24, 0, 15).toISOString()
          )
          .map((event) => event.id),
        []
      );
    }
  } finally {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
    db.db.close();
  }
});

test("calendar range queries suppress Apple mirrors of REST events", (t) => {
  const db = createDb(t);
  if (!db) return;

  registerProviderCalendars(db, { google: ["google-cal"], apple: ["apple-calendar"] });

  db.upsertCalendarEvents([
    restEvent("google", "google-cal", "google-copy"),
    appleEvent("apple-copy", {
      summary: "google-copy",
      start_time: "2026-07-22T10:00:00Z",
      end_time: "2026-07-22T11:00:00Z",
    }),
  ]);

  const events = db.getCalendarEventsInRange("2026-07-22T09:00:00Z", "2026-07-22T12:00:00Z");

  assert.deepEqual(
    events.map((event) => event.id),
    ["google-copy"]
  );
  db.db.close();
});

test("calendar range queries include only current selected calendars", (t) => {
  const db = createDb(t);
  if (!db) return;

  registerProviderCalendars(db, {
    google: ["google-selected", "google-disabled"],
    microsoft: ["microsoft-selected", "microsoft-disabled"],
    apple: ["apple-current"],
  });
  db.updateCalendarSelection("google-disabled", false);
  db.db
    .prepare("UPDATE microsoft_calendars SET is_selected = 0 WHERE id = ?")
    .run("microsoft-disabled");
  db.upsertCalendarEvents([
    restEvent("google", "google-selected", "google-selected-event"),
    restEvent("google", "google-disabled", "google-disabled-event"),
    restEvent("google", "google-missing", "google-orphan-event"),
    restEvent("microsoft", "microsoft-selected", "microsoft-selected-event"),
    restEvent("microsoft", "microsoft-disabled", "microsoft-disabled-event"),
    restEvent("apple", "apple-current", "apple-current-event"),
    restEvent("apple", "apple-missing", "apple-orphan-event"),
  ]);

  const events = db.getCalendarEventsInRange("2026-07-22T09:00:00Z", "2026-07-22T12:00:00Z");
  assert.deepEqual(events.map((event) => event.id).sort(), [
    "apple-current-event",
    "google-selected-event",
    "microsoft-selected-event",
  ]);
  db.db.close();
});

test("calendar range queries can exclude disconnected provider residue", (t) => {
  const db = createDb(t);
  if (!db) return;

  registerProviderCalendars(db, { google: ["google-current"], apple: ["apple-restored"] });
  db.upsertCalendarEvents([
    restEvent("google", "google-current", "google-event"),
    restEvent("apple", "apple-restored", "stale-apple-event"),
  ]);

  const events = db.getCalendarEventsInRange("2026-07-22T09:00:00Z", "2026-07-22T12:00:00Z", [
    "google",
  ]);
  assert.deepEqual(
    events.map((event) => event.id),
    ["google-event"]
  );
  db.db.close();
});

test("deselection clears incremental tokens before a calendar can be re-enabled", (t) => {
  const db = createDb(t);
  if (!db) return;

  registerProviderCalendars(db, {
    google: ["google-selected", "google-disabled"],
    microsoft: ["microsoft-selected", "microsoft-disabled"],
  });
  db.db
    .prepare(
      "UPDATE google_calendars SET sync_token = 'google-token', sync_token_expires_at = 9999999999999 WHERE id = 'google-disabled'"
    )
    .run();
  db.db
    .prepare(
      "UPDATE microsoft_calendars SET sync_token = 'microsoft-token', sync_token_expires_at = 9999999999999 WHERE id = 'microsoft-disabled'"
    )
    .run();
  db.updateCalendarSelection("google-disabled", false);
  db.db
    .prepare("UPDATE microsoft_calendars SET is_selected = 0 WHERE id = 'microsoft-disabled'")
    .run();
  db.upsertCalendarEvents([
    restEvent("google", "google-disabled", "google-disabled-event"),
    restEvent("microsoft", "microsoft-disabled", "microsoft-disabled-event"),
  ]);

  db.removeEventsFromDeselectedCalendars("google");
  db.removeEventsFromDeselectedCalendars("microsoft");

  assert.deepEqual(
    db.db
      .prepare(
        "SELECT sync_token, sync_token_expires_at FROM google_calendars WHERE id = 'google-disabled'"
      )
      .get(),
    { sync_token: null, sync_token_expires_at: null }
  );
  assert.deepEqual(
    db.db
      .prepare(
        "SELECT sync_token, sync_token_expires_at FROM microsoft_calendars WHERE id = 'microsoft-disabled'"
      )
      .get(),
    { sync_token: null, sync_token_expires_at: null }
  );
  assert.equal(db.getCalendarEventById("google-disabled-event"), null);
  assert.equal(db.getCalendarEventById("microsoft-disabled-event"), null);
  db.db.close();
});

test("authoritative REST calendar lists prune removed calendars without crossing accounts", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.saveGoogleCalendars(
    ["google-current", "google-stale"].map((id) => ({ id, summary: id })),
    "first@example.com"
  );
  db.saveGoogleCalendars([{ id: "google-other", summary: "other" }], "other@example.com");
  db.saveMicrosoftCalendars(
    ["microsoft-current", "microsoft-stale"].map((id) => ({ id, summary: id })),
    "first@example.com"
  );
  db.upsertCalendarEvents([
    restEvent("google", "google-stale", "google-stale-event"),
    restEvent("google", "google-stale", "google-stale-linked-event"),
    restEvent("google", "google-other", "google-other-event"),
    restEvent("microsoft", "microsoft-stale", "microsoft-stale-event"),
  ]);
  const note = db.saveNote("Linked stale calendar event", "", "meeting").note;
  db.updateNote(note.id, { calendar_event_id: "google-stale-linked-event" });

  db.saveGoogleCalendars([{ id: "google-current", summary: "current" }], "first@example.com");
  db.saveMicrosoftCalendars([{ id: "microsoft-current", summary: "current" }], "first@example.com");

  assert.equal(
    db.db.prepare("SELECT 1 FROM google_calendars WHERE id = 'google-stale'").get(),
    undefined
  );
  assert.equal(
    db.db.prepare("SELECT 1 FROM microsoft_calendars WHERE id = 'microsoft-stale'").get(),
    undefined
  );
  assert.ok(db.db.prepare("SELECT 1 FROM google_calendars WHERE id = 'google-other'").get());
  assert.equal(db.getCalendarEventById("google-stale-event"), null);
  assert.ok(db.getCalendarEventById("google-stale-linked-event"));
  assert.equal(db.getCalendarEventById("google-stale-linked-event").status, "cancelled");
  assert.equal(db.getCalendarEventById("microsoft-stale-event"), null);
  assert.ok(db.getCalendarEventById("google-other-event"));
  assert.deepEqual(
    db
      .getCalendarEventsInRange("2026-07-22T09:00:00Z", "2026-07-22T12:00:00Z")
      .map((event) => event.id),
    ["google-other-event"]
  );
  db.db.close();
});

test("calendar event upserts persist normalized self-response state", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertCalendarEvents([
    restEvent("microsoft", "calendar", "declined-event", {
      self_response_status: "declined",
    }),
  ]);

  assert.equal(db.getCalendarEventById("declined-event").self_response_status, "declined");
  db.db.close();
});
