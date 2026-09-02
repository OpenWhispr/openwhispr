const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");

function recordEvent(db, eventId, overrides = {}) {
  db.recordAnalyticsEvent({
    eventId,
    wordCount: 4,
    occurredAt: "2026-08-30T10:00:00.000Z",
    localDate: "2026-08-30",
    spokenDurationMs: 2_000,
    mode: "local",
    provider: "local-whisper",
    model: "small",
    ...overrides,
  });
}

test("analytics stays content-free and idempotent, and only syncs the signed-in account", (t) => {
  const db = createDb(t);
  if (!db) return;

  recordEvent(db, "event-1");
  recordEvent(db, "event-1", { wordCount: 5, provider: null, model: null });

  const columns = db.db.prepare("PRAGMA table_info(analytics_events)").all();
  assert.equal(
    columns.some((column) => column.name === "text"),
    false
  );
  assert.equal(db.getAnalyticsSummary().totalWords, 5);
  assert.equal(db.getAnalyticsSummary().totalDictations, 1);

  db.setActiveAccountId("account-a");
  assert.equal(db.getAnalyticsSummary().totalWords, 5, "guest activity stays visible on-device");
  assert.deepEqual(db.getPendingAnalyticsEvents(), [], "guest activity is never attributed");

  recordEvent(db, "event-2");
  const pending = db.getPendingAnalyticsEvents();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].event_id, "event-2");
  assert.equal(
    pending[0].counter_version,
    2,
    "new rows identify the Unicode-aware counting rule"
  );
  assert.equal(db.markAnalyticsEventsSynced(["event-2"]).updated, 1);
  assert.deepEqual(db.getPendingAnalyticsEvents(), []);
});

test("clearing history and deleting account data both erase analytics rows", (t) => {
  const db = createDb(t);
  if (!db) return;

  recordEvent(db, "event-1");
  db.clearTranscriptions();
  assert.equal(db.getAnalyticsSummary().totalDictations, 0);

  db.setActiveAccountId("account-a");
  recordEvent(db, "event-2");
  db.setActiveAccountId("account-b");
  recordEvent(db, "event-3");
  db.deleteAccountData("account-b");

  const remaining = db.db.prepare("SELECT event_id FROM analytics_events").all();
  assert.deepEqual(
    remaining.map((row) => row.event_id),
    ["event-2"],
    "only the deleted account's rows go"
  );
});

test("clearing history erases anonymous analytics and tombstones attributed analytics", (t) => {
  const db = createDb(t);
  if (!db) return;

  recordEvent(db, "guest-1");
  db.setActiveAccountId("account-a");
  recordEvent(db, "synced-1");
  recordEvent(db, "pending-1");
  db.markAnalyticsEventsSynced(["synced-1"]);

  db.clearTranscriptions();

  assert.equal(db.getAnalyticsSummary().totalDictations, 0);
  assert.deepEqual(db.getPendingAnalyticsEvents(), []);
  assert.equal(db.countUnclaimedAnalyticsEvents(), 0);
  assert.deepEqual(
    db.db
      .prepare("SELECT event_id FROM analytics_events WHERE deleted_at IS NOT NULL")
      .all()
      .map((row) => row.event_id)
      .sort(),
    ["pending-1", "synced-1"]
  );

  // A batch already in flight when the clear landed still gets accepted; the
  // late ack must not retire the delete tombstone.
  assert.equal(db.markAnalyticsEventsSynced(["pending-1"]).updated, 0);
  assert.deepEqual(
    db
      .getPendingAnalyticsDeletes()
      .map((row) => row.event_id)
      .sort(),
    ["pending-1", "synced-1"]
  );

  // A delayed producer for the same dictation must not revive a tombstone.
  recordEvent(db, "pending-1", { wordCount: 99 });
  assert.equal(db.getAnalyticsSummary().totalDictations, 0);
  assert.deepEqual(
    db
      .getPendingAnalyticsDeletes()
      .map((row) => row.event_id)
      .sort(),
    ["pending-1", "synced-1"]
  );
});

test("pre-sign-in analytics are attributed only by an explicit claim", (t) => {
  const db = createDb(t);
  if (!db) return;

  recordEvent(db, "guest-1");
  recordEvent(db, "guest-2");
  db.setActiveAccountId("account-a");
  recordEvent(db, "account-1");

  assert.equal(db.countUnclaimedAnalyticsEvents(), 2);
  assert.deepEqual(
    db.getPendingAnalyticsEvents().map((row) => row.event_id),
    ["account-1"],
    "signing in alone never adopts device-local rows"
  );

  assert.equal(db.claimAnonymousAnalyticsEvents().claimed, 2);
  assert.equal(db.countUnclaimedAnalyticsEvents(), 0);
  assert.deepEqual(
    db
      .getPendingAnalyticsEvents()
      .map((row) => row.event_id)
      .sort(),
    ["account-1", "guest-1", "guest-2"]
  );
});

// The batch endpoint requires occurred_at as well as local_date, and rejects
// an event that is missing either. Dropping it from the projection to keep the
// timestamp on the device would 400 every batch, so the wire shape is pinned
// here rather than left to the consent copy to imply.
test("the pending batch carries both the precise timestamp and the local date", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setActiveAccountId("account-a");
  recordEvent(db, "later", { occurredAt: "2026-08-30T18:00:00.000Z" });
  recordEvent(db, "earlier", { occurredAt: "2026-08-30T09:00:00.000Z" });

  const pending = db.getPendingAnalyticsEvents();
  assert.deepEqual(
    pending.map((row) => row.event_id),
    ["earlier", "later"],
    "the device orders the batch by when each dictation happened"
  );
  assert.deepEqual(
    pending.map((row) => row.occurred_at),
    ["2026-08-30T09:00:00.000Z", "2026-08-30T18:00:00.000Z"],
    "occurred_at is required by the batch schema, so it has to be on the wire"
  );
  for (const row of pending) {
    assert.equal(row.local_date, "2026-08-30");
  }
});
