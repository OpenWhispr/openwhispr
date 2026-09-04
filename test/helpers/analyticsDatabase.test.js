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
  assert.equal(pending[0].counter_version, 2, "new rows identify the Unicode-aware counting rule");
  assert.equal(db.markAnalyticsEventsSynced(["event-2"]).updated, 1);
  assert.deepEqual(db.getPendingAnalyticsEvents(), []);
});

test("clearing history and deleting account data both erase analytics rows", (t) => {
  const db = createDb(t);
  if (!db) return;

  recordEvent(db, "event-1");
  db.clearTranscriptions();
  assert.equal(db.getAnalyticsSummary().totalDictations, 0);
  const { cleared_through: deviceClearedThrough } = db.db
    .prepare("SELECT cleared_through FROM analytics_device_clear_state WHERE id = 1")
    .get();
  const afterClear = new Date(Date.parse(deviceClearedThrough) + 1_000).toISOString();

  db.setActiveAccountId("account-a");
  recordEvent(db, "event-2", { occurredAt: afterClear });
  db.setActiveAccountId("account-b");
  recordEvent(db, "event-3", { occurredAt: afterClear });
  db.deleteAccountData("account-b");

  const remaining = db.db.prepare("SELECT event_id FROM analytics_events").all();
  assert.deepEqual(
    remaining.map((row) => row.event_id),
    ["event-2"],
    "only the deleted account's rows go"
  );
});

test("clearing history tombstones only the counters the cloud actually holds", (t) => {
  const db = createDb(t);
  if (!db) return;

  recordEvent(db, "guest-1");
  db.setActiveAccountId("account-a");
  recordEvent(db, "synced-1");
  recordEvent(db, "pending-1");
  db.markAnalyticsEventsSynced(["synced-1"]);
  db.setActiveAccountId("account-b");
  recordEvent(db, "other-account");
  recordEvent(db, "other-account-tombstone");
  db.db
    .prepare(
      "UPDATE analytics_events SET deleted_at = datetime('now') WHERE event_id = 'other-account-tombstone'"
    )
    .run();
  db.setActiveAccountId("account-a");

  db.clearTranscriptions();

  assert.equal(db.getAnalyticsSummary().totalDictations, 0);
  assert.deepEqual(db.getPendingAnalyticsEvents(), []);
  assert.equal(db.countUnclaimedAnalyticsEvents(), 0);
  assert.deepEqual(
    db.db
      .prepare(
        "SELECT event_id FROM analytics_events WHERE account_id = 'account-a' AND deleted_at IS NOT NULL"
      )
      .all()
      .map((row) => row.event_id)
      .sort(),
    ["synced-1"],
    "only an uploaded counter leaves a tombstone; pending-1 never reached the cloud"
  );
  assert.deepEqual(
    db.db
      .prepare("SELECT event_id FROM analytics_events WHERE account_id = 'account-b'")
      .all()
      .map((row) => row.event_id),
    ["other-account-tombstone"],
    "another account's pending cloud deletion survives"
  );

  // A batch already in flight when the clear landed still gets accepted; the
  // late ack must not retire the delete tombstone.
  assert.equal(db.markAnalyticsEventsSynced(["pending-1"]).updated, 0);
  assert.deepEqual(
    db
      .getPendingAnalyticsDeletes()
      .map((row) => row.event_id)
      .sort(),
    ["synced-1"],
    "the erase queued for the cloud covers exactly what the cloud was given"
  );

  // A delayed producer for the same dictation must not revive a tombstone.
  recordEvent(db, "pending-1", { wordCount: 99 });
  assert.equal(db.getAnalyticsSummary().totalDictations, 0);
  assert.deepEqual(
    db
      .getPendingAnalyticsDeletes()
      .map((row) => row.event_id)
      .sort(),
    ["synced-1"]
  );

  const pendingClear = db.getPendingAnalyticsClear();
  assert.match(pendingClear.cleared_through, /^\d{4}-\d{2}-\d{2}T/);
  recordEvent(db, "late-pre-clear", {
    occurredAt: new Date(Date.parse(pendingClear.cleared_through) - 1).toISOString(),
  });
  assert.equal(db.getAnalyticsSummary().totalDictations, 0);

  db.setActiveAccountId("account-b");
  assert.equal(db.getPendingAnalyticsClear(), null, "the clear belongs to the active account");
  recordEvent(db, "late-other-account", {
    occurredAt: new Date(Date.parse(pendingClear.cleared_through) - 1).toISOString(),
  });
  assert.equal(db.getAnalyticsSummary().totalDictations, 0);
  db.setActiveAccountId("account-a");
  recordEvent(db, "newer-retention", {
    occurredAt: new Date(Date.parse(pendingClear.cleared_through) + 1_000).toISOString(),
  });
  db.db
    .prepare(
      "UPDATE analytics_events SET deleted_at = datetime('now') WHERE event_id = 'newer-retention'"
    )
    .run();

  assert.equal(db.completeAnalyticsClear("2000-01-01T00:00:00.000Z").deleted, 0);
  assert.deepEqual(db.getPendingAnalyticsClear(), pendingClear);
  // One, not two: pending-1 was erased outright at clear time rather than
  // tombstoned, because the cloud never received it.
  assert.equal(db.completeAnalyticsClear(pendingClear.cleared_through).deleted, 1);
  assert.equal(db.getPendingAnalyticsClear(), null);
  recordEvent(db, "later-pre-clear", {
    occurredAt: new Date(Date.parse(pendingClear.cleared_through) - 1).toISOString(),
  });
  assert.equal(db.getAnalyticsSummary().totalDictations, 0);
  assert.deepEqual(db.getPendingAnalyticsDeletes(), [{ event_id: "newer-retention" }]);
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

test("signed-out clearing is device-only and preserves queued account deletions", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setActiveAccountId("account-a");
  recordEvent(db, "live-account-event");
  recordEvent(db, "pending-account-delete");
  db.db
    .prepare(
      "UPDATE analytics_events SET deleted_at = datetime('now') WHERE event_id = 'pending-account-delete'"
    )
    .run();
  db.setActiveAccountId(null);

  db.clearTranscriptions();

  assert.equal(db.getAnalyticsSummary().totalDictations, 0);
  assert.equal(db.getPendingAnalyticsClear(), null);
  const { cleared_through: deviceClearedThrough } = db.db
    .prepare("SELECT cleared_through FROM analytics_device_clear_state WHERE id = 1")
    .get();
  recordEvent(db, "late-guest-event", {
    occurredAt: new Date(Date.parse(deviceClearedThrough) - 1).toISOString(),
  });
  assert.equal(db.getAnalyticsSummary().totalDictations, 0);
  db.setActiveAccountId("account-a");
  assert.deepEqual(db.getPendingAnalyticsDeletes(), [{ event_id: "pending-account-delete" }]);
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

test("the opt-in count covers everything turning sync on would upload", (t) => {
  const db = createDb(t);
  if (!db) return;

  // The prompt used to be driven by the pre-sign-in count alone. Every
  // dictation made while signed in is already attributed, so a long-signed-in
  // user had nothing "unclaimed", saw no prompt, and uploaded their whole
  // history on the next pass.
  recordEvent(db, "before-sign-in");
  db.setActiveAccountId("account-a");
  recordEvent(db, "while-signed-in-1");
  recordEvent(db, "while-signed-in-2");

  assert.equal(db.countUnclaimedAnalyticsEvents(), 1, "only the pre-sign-in row is unclaimed");
  assert.equal(
    db.countAnalyticsEventsAwaitingUpload(),
    3,
    "but three rows would actually leave the device"
  );

  db.markAnalyticsEventsSynced(["while-signed-in-1"]);
  assert.equal(db.countAnalyticsEventsAwaitingUpload(), 2, "an uploaded row is no longer pending");

  db.setActiveAccountId("account-b");
  assert.equal(
    db.countAnalyticsEventsAwaitingUpload(),
    1,
    "another account sees only the unattributed row, never account-a's"
  );
});
