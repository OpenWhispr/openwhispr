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

test("clearing history tombstones every owned analytics row so the cloud copy can be retired", (t) => {
  const db = createDb(t);
  if (!db) return;

  recordEvent(db, "guest-1");
  db.setActiveAccountId("account-a");
  recordEvent(db, "synced-1");
  recordEvent(db, "pending-1");
  db.markAnalyticsEventsSynced(["synced-1"]);

  db.clearTranscriptions();

  assert.equal(db.getAnalyticsSummary().totalDictations, 0, "tombstones leave the summary");
  assert.deepEqual(db.getPendingAnalyticsEvents(), [], "tombstones are never re-uploaded");
  assert.equal(db.countUnclaimedAnalyticsEvents(), 0, "the unattributed row is gone outright");
  assert.deepEqual(
    db
      .getPendingAnalyticsDeletes()
      .map((row) => row.event_id)
      .sort(),
    ["pending-1", "synced-1"],
    "every row that could have reached the cloud becomes a pending delete"
  );

  // A batch already in flight when the clear landed still gets accepted; the
  // late ack must not resurrect the row out of its tombstone.
  assert.equal(db.markAnalyticsEventsSynced(["pending-1"]).updated, 0);
  assert.deepEqual(
    db
      .getPendingAnalyticsDeletes()
      .map((row) => row.event_id)
      .sort(),
    ["pending-1", "synced-1"],
    "a late accept cannot un-tombstone a cleared row"
  );

  assert.equal(db.hardDeleteAnalyticsEvents(["pending-1", "synced-1"]).deleted, 2);
  assert.deepEqual(db.getPendingAnalyticsDeletes(), []);
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

test("an event the server keeps refusing is retired so it stops blocking the queue", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setActiveAccountId("account-a");
  // The bad row is older, so it sorts ahead of the good one and would be
  // re-offered on every pass forever if nothing counted the refusals.
  recordEvent(db, "bad-1", { occurredAt: "2026-08-30T09:00:00.000Z" });
  recordEvent(db, "good-1", { occurredAt: "2026-08-30T11:00:00.000Z" });

  // Four refusals is not enough to give up on it.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal(db.recordAnalyticsSyncFailures(["bad-1"]).retired, 0);
    assert.deepEqual(
      db.getPendingAnalyticsEvents().map((row) => row.event_id),
      ["bad-1", "good-1"],
      "still offered while it has attempts left"
    );
  }

  assert.equal(db.recordAnalyticsSyncFailures(["bad-1"]).retired, 1);
  assert.deepEqual(
    db.getPendingAnalyticsEvents().map((row) => row.event_id),
    ["good-1"],
    "the retired row no longer blocks the queue"
  );
  // Retiring an upload is not deleting a dictation.
  assert.equal(db.getAnalyticsSummary().totalDictations, 2);

  // Already retired, so further refusals are inert rather than cumulative.
  assert.equal(db.recordAnalyticsSyncFailures(["bad-1"]).retired, 0);
  assert.equal(db.recordAnalyticsSyncFailures([]).retired, 0);
});

test("a successful upload never counts against a retry budget", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setActiveAccountId("account-a");
  recordEvent(db, "event-1");
  db.recordAnalyticsSyncFailures(["event-1"]);
  assert.equal(db.markAnalyticsEventsSynced(["event-1"]).updated, 1);
  assert.deepEqual(db.getPendingAnalyticsEvents(), []);

  // A cleared row still becomes a pending delete even after refusals, so the
  // cloud copy is retired if one of the earlier attempts did land.
  db.clearTranscriptions();
  assert.deepEqual(
    db.getPendingAnalyticsDeletes().map((row) => row.event_id),
    ["event-1"]
  );
});
