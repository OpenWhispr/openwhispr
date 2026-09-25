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
    connector: "email",
    action: "draft",
    kind: "direct",
    destinationLabel: "gabe@example.com",
    state: "sent",
  });
  log.insert({
    id: "a2",
    connector: "slack",
    action: "send_message",
    kind: "approval",
    destinationLabel: "#eng",
    state: "pending",
  });
  log.update("a2", { state: "committing" });
  log.update("a2", { state: "sent", resultUrl: "https://slack.test/p/1" });

  const [row] = log.listRecent("slack", 10);
  assert.equal(row.id, "a2");
  assert.equal(row.state, "sent");
  assert.equal(row.resultUrl, "https://slack.test/p/1");
  assert.equal(row.destinationLabel, "#eng");
  assert.equal(log.listRecent("email", 10)[0].kind, "direct");
  db.db.close();
});

test("rows interrupted by a quit are reconciled on the next launch", (t) => {
  const db = createDb(t);
  if (!db) return;
  const log = createActionLog(db);
  log.insert({
    id: "p1",
    connector: "slack",
    action: "send_message",
    kind: "approval",
    state: "pending",
  });
  log.insert({
    id: "c1",
    connector: "slack",
    action: "send_message",
    kind: "approval",
    state: "committing",
  });
  log.insert({
    id: "s1",
    connector: "slack",
    action: "send_message",
    kind: "approval",
    state: "sent",
  });

  assert.deepEqual(log.reconcileInterrupted(), { unknown: 1, cancelled: 1 });

  const states = Object.fromEntries(log.listRecent("slack", 10).map((row) => [row.id, row]));
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

test("receipts belong to the account that took the action", (t) => {
  const db = createDb(t);
  if (!db) return;
  const log = createActionLog(db);
  log.insert({
    id: "a1",
    connector: "email",
    action: "draft",
    kind: "direct",
    destinationLabel: "gabe@example.com",
    state: "sent",
  });
  db.setActiveAccountId("account-b");
  log.insert({
    id: "b1",
    connector: "email",
    action: "draft",
    kind: "direct",
    destinationLabel: "dana@example.com",
    state: "sent",
  });

  assert.deepEqual(
    log.listRecent("email", 10).map((row) => row.id),
    ["b1"]
  );
  db.setActiveAccountId(null);
  assert.deepEqual(log.listRecent("email", 10), []);

  db.setActiveAccountId("account-a");
  assert.deepEqual(
    log.listRecent("email", 10).map((row) => row.id),
    ["a1"]
  );
  db.deleteAccountData("account-a");
  assert.deepEqual(log.listRecent("email", 10), []);
  db.setActiveAccountId("account-b");
  assert.deepEqual(
    log.listRecent("email", 10).map((row) => row.id),
    ["b1"]
  );
  db.db.close();
});

test("listRecent respects the limit", (t) => {
  const db = createDb(t);
  if (!db) return;
  const log = createActionLog(db);
  for (let i = 0; i < 5; i += 1) {
    log.insert({ id: `e${i}`, connector: "email", action: "draft", kind: "direct", state: "sent" });
  }
  assert.equal(log.listRecent("email", 3).length, 3);
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
  db.upsertContacts([{ email: "Priya@Example.com", displayName: "Priya Shah" }]);
  db.saveGoogleCalendars([{ id: "primary", summary: "Chad" }], "chad@example.com");
  db.saveMicrosoftCalendars([{ id: "work", summary: "Calendar" }], "chad@corp.test");

  const sources = db.getContactLookupSources();

  // The meetings nearest to now come first, so a limit keeps the relevant ones.
  assert.deepEqual(
    sources.meetings.map((row) => row.organizer_email),
    ["soon@example.com", "later@example.com"]
  );
  assert.match(sources.meetings[0].attendees, /Someone/);
  assert.equal(sources.meetings[0].provider, "google");
  assert.deepEqual(sources.contacts, [{ email: "priya@example.com", display_name: "Priya Shah" }]);
  assert.deepEqual([...sources.accountEmails].sort(), ["chad@corp.test", "chad@example.com"]);
  db.db.close();
});

test("contacts come most recently synced first, and removeContacts purges addresses", (t) => {
  const db = createDb(t);
  if (!db) return;
  db.upsertContacts([
    { email: "old@example.com", displayName: "Josh Old" },
    { email: "new@example.com", displayName: "Josh New" },
  ]);
  db.db.prepare("UPDATE contacts SET updated_at = '2020-01-01 00:00:00' WHERE email = ?").run("old@example.com");

  assert.deepEqual(
    db.getContactLookupSources().contacts.map((row) => row.email),
    ["new@example.com", "old@example.com"]
  );
  db.removeContacts(["New@Example.com"]);
  assert.deepEqual(
    db.getContactLookupSources().contacts.map((row) => row.email),
    ["old@example.com"]
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
