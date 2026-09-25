const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-connector-actions-db-"));
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
const { createActionLog } = require("../../src/helpers/connectors/actionLog.js");

function isNativeBindingUnavailable(error) {
  const message = String(error?.message || error);
  return (
    message.includes("NODE_MODULE_VERSION") ||
    message.includes("Could not locate the bindings file")
  );
}

function createDb(t) {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-connector-actions-db-"));
  try {
    const db = new DatabaseManager();
    db.setActiveAccountId("account-a");
    return db;
  } catch (error) {
    if (isNativeBindingUnavailable(error)) {
      t.skip("better-sqlite3 native binding is not available for this Node runtime");
      return null;
    }
    throw error;
  }
}

test("an action row moves through its states and lists newest first", (t) => {
  const db = createDb(t);
  if (!db) return;
  const log = createActionLog(db);

  log.insert({
    id: "a1",
    accountId: "account-a",
    connector: "email",
    action: "draft",
    kind: "direct",
    destinationLabel: "gabe@example.com",
    state: "sent",
  });
  log.insert({
    id: "a2",
    accountId: "account-a",
    connector: "slack",
    action: "send_message",
    kind: "approval",
    destinationLabel: "#eng",
    state: "pending",
  });
  log.update("a2", { state: "committing" });
  log.update("a2", { state: "sent", resultUrl: "https://slack.test/p/1" });

  const [row] = log.listRecent("slack", 10, "account-a");
  assert.equal(row.id, "a2");
  assert.equal(row.state, "sent");
  assert.equal(row.resultUrl, "https://slack.test/p/1");
  assert.equal(row.destinationLabel, "#eng");
  assert.equal(log.listRecent("email", 10, "account-a")[0].kind, "direct");
  db.db.close();
});

test("rows interrupted by a quit are reconciled on the next launch", (t) => {
  const db = createDb(t);
  if (!db) return;
  const log = createActionLog(db);
  log.insert({
    id: "p1",
    accountId: "account-a",
    connector: "slack",
    action: "send_message",
    kind: "approval",
    state: "pending",
  });
  log.insert({
    id: "c1",
    accountId: "account-a",
    connector: "slack",
    action: "send_message",
    kind: "approval",
    state: "committing",
  });
  log.insert({
    id: "s1",
    accountId: "account-a",
    connector: "slack",
    action: "send_message",
    kind: "approval",
    state: "sent",
  });

  assert.deepEqual(log.reconcileInterrupted(), { unknown: 1, cancelled: 1, orphaned: 0 });

  const states = Object.fromEntries(
    log.listRecent("slack", 10, "account-a").map((row) => [row.id, row])
  );
  assert.equal(states.c1.state, "unknown");
  assert.equal(states.c1.errorCode, "app_quit");
  assert.equal(states.p1.state, "cancelled");
  assert.equal(states.s1.state, "sent");
  db.db.close();
});

test("a guarded update only moves a row out of the expected state", (t) => {
  const db = createDb(t);
  if (!db) return;
  const log = createActionLog(db);
  log.insert({
    id: "g1",
    accountId: "account-a",
    connector: "slack",
    action: "send_message",
    kind: "approval",
    state: "pending",
  });

  assert.equal(log.update("g1", { state: "committing" }, "pending"), 1);
  assert.equal(log.update("g1", { state: "committing" }, "pending"), 0);
  assert.equal(log.update("missing", { state: "committing" }, "pending"), 0);
  assert.equal(log.update("g1", { state: "sent" }), 1);
  db.db.close();
});

test("a receipt belongs to the account it names, whatever the database scope says", (t) => {
  const db = createDb(t);
  if (!db) return;
  const log = createActionLog(db);
  const draft = (id, accountId, destinationLabel) =>
    log.insert({
      id,
      accountId,
      connector: "email",
      action: "draft",
      kind: "direct",
      destinationLabel,
      state: "sent",
    });

  draft("a1", "account-a", "gabe@example.com");
  // The A -> B gap: B's credential is in use, the database scope still says A.
  draft("b1", "account-b", "dana@example.com");
  // The null-scope gap: signed in as B, database scope not synced yet.
  db.setActiveAccountId(null);
  draft("b2", "account-b", "lee@example.com");

  db.setActiveAccountId("account-a");
  assert.deepEqual(
    log.listRecent("email", 10, "account-a").map((row) => row.id),
    ["a1"]
  );
  assert.deepEqual(
    log.listRecent("email", 10, "account-b").map((row) => row.id),
    ["b2", "b1"]
  );
  assert.deepEqual(log.listRecent("email", 10, null), []);

  db.deleteAccountData("account-a");
  assert.deepEqual(log.listRecent("email", 10, "account-a"), []);
  assert.equal(log.listRecent("email", 10, "account-b").length, 2);
  db.db.close();
});

test("receipts with no account are removed on launch", (t) => {
  const db = createDb(t);
  if (!db) return;
  const log = createActionLog(db);
  log.insert({
    id: "legacy",
    accountId: null,
    connector: "email",
    action: "draft",
    kind: "direct",
    state: "sent",
  });
  log.insert({
    id: "kept",
    accountId: "account-a",
    connector: "email",
    action: "draft",
    kind: "direct",
    state: "sent",
  });

  assert.deepEqual(log.reconcileInterrupted(), { unknown: 0, cancelled: 0, orphaned: 1 });
  assert.deepEqual(
    db.db
      .prepare("SELECT id FROM connector_actions")
      .all()
      .map((row) => row.id),
    ["kept"]
  );
  db.db.close();
});

test("listRecent respects the limit", (t) => {
  const db = createDb(t);
  if (!db) return;
  const log = createActionLog(db);
  for (let i = 0; i < 5; i += 1) {
    log.insert({
      id: `e${i}`,
      accountId: "account-a",
      connector: "email",
      action: "draft",
      kind: "direct",
      state: "sent",
    });
  }
  assert.equal(log.listRecent("email", 3, "account-a").length, 3);
  db.db.close();
});

test("contact lookup sources cover meetings, synced contacts and the user's accounts", (t) => {
  const db = createDb(t);
  if (!db) return;
  const event = (id, startTime, organizer) => ({
    id,
    calendar_id: "primary",
    provider: "google",
    summary: "Lunch",
    start_time: startTime,
    end_time: startTime,
    is_all_day: false,
    status: "confirmed",
    organizer_email: organizer,
    attendees_count: 1,
    attendees: JSON.stringify([{ email: organizer, displayName: "Someone", self: false }]),
  });
  const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const later = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
  db.upsertCalendarEvents([
    event("evt-later", later, "later@example.com"),
    event("evt-soon", soon, "soon@example.com"),
    // A meeting the user never had can't count as meeting anyone.
    { ...event("evt-cancelled", soon, "cancelled@example.com"), status: "cancelled" },
    { ...event("evt-declined", soon, "declined@example.com"), self_response_status: "declined" },
  ]);
  db.upsertContacts([{ email: "Priya@Example.com", displayName: "Priya Shah" }], "manual");
  db.saveGoogleCalendars(
    [{ id: "primary", summary: "Chad", is_primary: true }],
    "chad@example.com"
  );
  db.saveMicrosoftCalendars([{ id: "work", summary: "Calendar" }], "chad@corp.test");

  const sources = db.getContactLookupSources();

  // The meetings nearest to now come first, so a limit keeps the relevant ones.
  assert.deepEqual(
    sources.meetings.map((row) => row.organizer_email),
    ["soon@example.com", "later@example.com"]
  );
  assert.match(sources.meetings[0].attendees, /Someone/);
  assert.equal(sources.meetings[0].self_is_user, 1);
  assert.deepEqual(sources.contacts, [{ email: "priya@example.com", display_name: "Priya Shah" }]);
  assert.deepEqual([...sources.accountEmails].sort(), ["chad@corp.test", "chad@example.com"]);
  db.db.close();
});

test("contacts come most recently synced first, and a sync purges the addresses it keeps out", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.upsertContacts(
    [
      { email: "old@example.com", displayName: "Josh Old" },
      { email: "new@example.com", displayName: "Josh New" },
    ],
    "manual"
  );
  db.db
    .prepare("UPDATE contacts SET updated_at = '2020-01-01 00:00:00' WHERE email = ?")
    .run("old@example.com");

  assert.deepEqual(
    db.getContactLookupSources().contacts.map((row) => row.email),
    ["new@example.com", "old@example.com"]
  );
  db.syncCalendarContacts("apple", null, [], ["New@Example.com"]);
  assert.deepEqual(
    db.getContactLookupSources().contacts.map((row) => row.email),
    ["old@example.com"]
  );
  db.db.close();
});

test("an attendee's self flag means the user except on a colleague's shared Google calendar", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.saveGoogleCalendars(
    [
      { id: "me@example.com", summary: "Me" },
      { id: "dana@example.com", summary: "Dana" },
    ],
    "me@example.com"
  );
  const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const event = (id, provider, calendarId) => ({
    id,
    calendar_id: calendarId,
    provider,
    start_time: soon,
    end_time: soon,
    is_all_day: false,
    status: "confirmed",
    organizer_email: `${id}@example.com`,
    attendees_count: 0,
    attendees: null,
  });
  db.upsertCalendarEvents([
    event("own", "google", "me@example.com"),
    event("shared", "google", "dana@example.com"),
    event("work", "microsoft", "work"),
    event("home", "apple", "home"),
  ]);

  const selfIsUser = Object.fromEntries(
    db.getContactLookupSources().meetings.map((row) => [row.organizer_email, row.self_is_user])
  );
  assert.deepEqual(selfIsUser, {
    "own@example.com": 1,
    "shared@example.com": 0,
    "work@example.com": 1,
    "home@example.com": 1,
  });
  db.db.close();
});

function storedContactEmails(db) {
  return db.db
    .prepare("SELECT email FROM contacts ORDER BY email")
    .all()
    .map((row) => row.email);
}

test("contact lookup only sees hand-added contacts and connected accounts' contacts", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.saveGoogleCalendars([{ id: "g-cal", summary: "Me" }], "me@gmail.test");
  db.saveMicrosoftCalendars([{ id: "m-cal", summary: "Calendar" }], "me@corp.test");
  db.saveAppleCalendars([{ id: "a-cal", title: "Home" }]);
  db.syncCalendarContacts("google", "me@gmail.test", [{ email: "g@example.com" }], []);
  db.syncCalendarContacts("microsoft", "me@corp.test", [{ email: "m@example.com" }], []);
  db.syncCalendarContacts("apple", null, [{ email: "a@example.com" }], []);
  db.upsertContacts([{ email: "hand@example.com" }], "manual");
  // Synced by both accounts: the latest sync owns it.
  db.syncCalendarContacts("google", "me@gmail.test", [{ email: "both@example.com" }], []);
  db.syncCalendarContacts("microsoft", "me@corp.test", [{ email: "both@example.com" }], []);
  // Stored by an older build, before contacts had a source.
  db.db
    .prepare("INSERT INTO contacts (email, display_name) VALUES (?, ?)")
    .run("lincoln-room@corp.test", "Lincoln Room");

  const lookup = () =>
    db
      .getContactLookupSources()
      .contacts.map((row) => row.email)
      .sort();
  assert.deepEqual(lookup(), [
    "a@example.com",
    "both@example.com",
    "g@example.com",
    "hand@example.com",
    "m@example.com",
  ]);
  // Note-participant autocomplete still offers the legacy row.
  assert.equal(db.searchContacts("lincoln").length, 1);

  const stored = () => storedContactEmails(db);
  db.removeGoogleAccount("me@gmail.test");
  assert.deepEqual(stored(), [
    "a@example.com",
    "both@example.com",
    "hand@example.com",
    "lincoln-room@corp.test",
    "m@example.com",
  ]);
  db.removeMicrosoftAccount("me@corp.test");
  db.clearAppleCalendarData();
  assert.deepEqual(stored(), ["hand@example.com", "lincoln-room@corp.test"]);
  assert.deepEqual(lookup(), ["hand@example.com"]);
  // A snapshot that lands after the disconnect still isn't a connected account.
  db.syncCalendarContacts("apple", null, [{ email: "late@example.com" }], []);
  assert.deepEqual(lookup(), ["hand@example.com"]);
  db.db.close();
});

test("clearing a provider removes every one of its accounts' contacts", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.syncCalendarContacts("google", "a@gmail.test", [{ email: "g1@example.com" }], []);
  db.syncCalendarContacts("google", "b@gmail.test", [{ email: "g2@example.com" }], []);
  db.syncCalendarContacts("microsoft", "a@corp.test", [{ email: "m1@example.com" }], []);
  db.syncCalendarContacts("microsoft", "b@corp.test", [{ email: "m2@example.com" }], []);
  db.upsertContacts([{ email: "hand@example.com" }], "manual");

  db.clearGoogleCalendarData();
  assert.deepEqual(storedContactEmails(db), [
    "hand@example.com",
    "m1@example.com",
    "m2@example.com",
  ]);
  db.clearMicrosoftCalendarData();
  assert.deepEqual(storedContactEmails(db), ["hand@example.com"]);
  db.db.close();
});

test("a hand-added contact stays the user's when a calendar later syncs it", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.saveGoogleCalendars([{ id: "g-cal", summary: "Me" }], "me@gmail.test");
  db.upsertContacts([{ email: "hand@example.com" }], "manual");
  db.syncCalendarContacts("google", "me@gmail.test", [{ email: "hand@example.com" }], []);

  db.removeGoogleAccount("me@gmail.test");
  assert.deepEqual(storedContactEmails(db), ["hand@example.com"]);
  assert.deepEqual(
    db.getContactLookupSources().contacts.map((row) => row.email),
    ["hand@example.com"]
  );
  db.db.close();
});

test("upgrading to user_version 3 forces a full calendar re-sync", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.saveGoogleCalendars([{ id: "primary", summary: "Chad" }], "chad@example.com");
  db.saveMicrosoftCalendars([{ id: "work", summary: "Calendar" }], "chad@corp.test");
  db.updateCalendarSyncToken("primary", "google-token", Date.now() + 60_000);
  db.updateMicrosoftCalendarSyncToken("work", "microsoft-token", Date.now() + 60_000);
  db.db.pragma("user_version = 2");
  db.db.close();

  // Same user data directory: the next launch runs the migration.
  const reopened = new DatabaseManager();
  const tokens = reopened.db
    .prepare(
      "SELECT sync_token FROM google_calendars UNION ALL SELECT sync_token FROM microsoft_calendars"
    )
    .all();
  assert.deepEqual(tokens, [{ sync_token: null }, { sync_token: null }]);
  assert.equal(reopened.db.pragma("user_version", { simple: true }), 3);
  reopened.db.close();
});
