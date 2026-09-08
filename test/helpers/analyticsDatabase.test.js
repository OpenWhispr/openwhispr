const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const { localDateKey } = require("../../src/helpers/analytics.js");

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

test("historical transcriptions reconcile in restart-safe account-neutral batches", (t) => {
  const db = createDb(t);
  if (!db) return;

  const insertTranscription = db.db.prepare(
    `INSERT INTO transcriptions (
       text, raw_text, status, client_transcription_id, timestamp, created_at,
       audio_duration_ms, provider, model, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertTranscription.run(
    "enhanced text",
    "one two three",
    "completed",
    "legacy-local",
    "2026-09-01T09:59:00.000Z",
    "2026-09-01 10:00:00",
    2_000,
    "local-whisper",
    "small",
    null
  );
  insertTranscription.run(
    "four five",
    null,
    "completed",
    "legacy-ambiguous",
    "2026-09-02T09:59:00.000Z",
    "2026-09-02 10:00:00",
    null,
    "deepgram-streaming",
    "nova-3",
    null
  );
  insertTranscription.run(
    "ambiguous post-clear words",
    null,
    "completed",
    "legacy-post-clear-ambiguous",
    "2026-09-03 10:00:00",
    "2026-09-03 10:00:00",
    null,
    null,
    null,
    null
  );
  insertTranscription.run(
    "cleared words",
    null,
    "completed",
    "legacy-cleared",
    "2026-08-01T09:59:00.000Z",
    "2026-08-01 10:00:00",
    null,
    null,
    null,
    null
  );
  insertTranscription.run(
    "failed words",
    null,
    "failed",
    "legacy-failed",
    "2026-09-03 10:00:00",
    "2026-09-03 10:00:00",
    null,
    null,
    null,
    null
  );
  insertTranscription.run(
    "timestamp unavailable",
    null,
    "completed",
    "legacy-invalid-time",
    "not-a-time",
    "not-a-time",
    null,
    null,
    null,
    null
  );
  insertTranscription.run(
    "deleted words",
    null,
    "completed",
    "legacy-deleted",
    "2026-09-03 10:00:00",
    "2026-09-03 10:00:00",
    null,
    null,
    null,
    "2026-09-03 11:00:00"
  );
  insertTranscription.run(
    "existing words",
    null,
    "completed",
    "legacy-existing",
    "2026-09-04 10:00:00",
    "2026-09-04 10:00:00",
    null,
    null,
    null,
    null
  );
  db.db
    .prepare(
      "INSERT INTO analytics_device_clear_state (id, cleared_through) VALUES (1, '2026-08-15T00:00:00.000Z')"
    )
    .run();
  recordEvent(db, "legacy-existing", {
    wordCount: 2,
    occurredAt: "2026-09-04T10:00:00.000Z",
  });
  db.db
    .prepare(
      "UPDATE analytics_events SET deleted_at = '2026-09-04T11:00:00.000Z' WHERE event_id = 'legacy-existing'"
    )
    .run();
  db.setActiveAccountId("account-a");

  const batches = [];
  let afterId = 0;
  do {
    const batch = db.backfillAnalyticsHistoryBatch({ afterId, limit: 1 });
    batches.push(batch);
    afterId = batch.nextCursor;
  } while (!batches[batches.length - 1].complete);

  assert.equal(
    batches.reduce((total, batch) => total + batch.inserted, 0),
    2
  );
  assert.equal(db.getAnalyticsSummary().totalWords, 5);
  assert.equal(db.getAnalyticsSummary().totalDictations, 2);
  assert.equal(db.countUnclaimedAnalyticsEvents(), 2, "the active account does not adopt history");
  assert.deepEqual(
    db.db
      .prepare(
        `SELECT event_id, account_id, word_count, spoken_duration_ms, mode,
                counter_version, created_at
         FROM analytics_events WHERE deleted_at IS NULL ORDER BY event_id`
      )
      .all(),
    [
      {
        event_id: "legacy-ambiguous",
        account_id: null,
        word_count: 2,
        spoken_duration_ms: null,
        mode: "unknown",
        counter_version: 2,
        created_at: "2026-09-02 10:00:00",
      },
      {
        event_id: "legacy-local",
        account_id: null,
        word_count: 3,
        spoken_duration_ms: 2_000,
        mode: "local",
        counter_version: 2,
        created_at: "2026-09-01 10:00:00",
      },
    ]
  );
  assert.deepEqual(db.backfillAnalyticsHistoryBatch(), {
    complete: true,
    nextCursor: 0,
    scanned: 0,
    inserted: 0,
    skipped: 0,
  });
});

test("analytics reconciliation picks up later eligibility and usable processed text", (t) => {
  const db = createDb(t);
  if (!db) return;

  const insert = db.db.prepare(
    `INSERT INTO transcriptions (
       text, raw_text, status, client_transcription_id, timestamp, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`
  );
  insert.run(
    "processed text wins",
    "   ",
    "completed",
    "empty-raw",
    "2026-09-01 10:00:00",
    "2026-09-01 10:00:00"
  );
  insert.run(
    "retry succeeds later",
    null,
    "failed",
    "retried-later",
    "2026-09-02 10:00:00",
    "2026-09-02 10:00:00"
  );

  assert.equal(db.backfillAnalyticsHistoryBatch().inserted, 1);
  assert.equal(db.getAnalyticsSummary().totalWords, 3);

  db.db
    .prepare("UPDATE transcriptions SET status = 'completed' WHERE client_transcription_id = ?")
    .run("retried-later");
  assert.equal(db.backfillAnalyticsHistoryBatch().inserted, 1);
  assert.equal(db.getAnalyticsSummary().totalWords, 6);

  insert.run(
    "pulled after startup",
    null,
    "completed",
    "pulled-later",
    "2025-01-01 10:00:00",
    "2025-01-01 10:00:00"
  );
  assert.equal(db.backfillAnalyticsHistoryBatch().inserted, 1);
  assert.equal(db.backfillAnalyticsHistoryBatch().scanned, 0);
});

test("a dictation whose time cannot be read stays out instead of landing on today", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.db
    .prepare(
      `INSERT INTO transcriptions (
         text, status, client_transcription_id, timestamp, created_at
       ) VALUES ('undateable words', 'completed', 'no-usable-time', 'not-a-time', 'not-a-time')`
    )
    .run();

  assert.deepEqual(db.backfillAnalyticsHistoryBatch(), {
    complete: true,
    nextCursor: 1,
    scanned: 1,
    inserted: 0,
    skipped: 1,
  });
  const summary = db.getAnalyticsSummary();
  assert.equal(summary.totalDictations, 0, "an undateable row must not become today's dictation");
  assert.equal(summary.currentStreakDays, 0, "and must not manufacture a streak");
});

// SQLite reads a bare YYYY-MM-DD as carrying a zone, because the day hyphen
// sits six characters from the end, so the query's shape test admits a row the
// JS side then dates from created_at instead. Nothing writes that shape today,
// but the boundary has to hold on the instant actually written, not on the
// column the query happened to filter.
test("history the user cleared cannot come back through a mis-shaped timestamp", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.db
    .prepare(
      `INSERT INTO transcriptions (
         text, status, client_transcription_id, timestamp, created_at
       ) VALUES ('cleared words', 'completed', 'shape-bypass', '2027-01-01',
                 '2026-01-02 03:04:05')`
    )
    .run();
  db.db
    .prepare(
      "INSERT INTO analytics_device_clear_state (id, cleared_through) VALUES (1, '2026-08-15T00:00:00.000Z')"
    )
    .run();

  assert.deepEqual(db.backfillAnalyticsHistoryBatch(), {
    complete: true,
    nextCursor: 1,
    scanned: 1,
    inserted: 0,
    skipped: 1,
  });
  assert.equal(db.getAnalyticsSummary().totalDictations, 0);
});

// upsertTranscriptionFromCloud carries the cloud created_at but lets timestamp
// default to the local pull, so trusting a naive timestamp would date every
// pulled dictation to the day this device happened to sync.
test("a cloud-pulled dictation is dated from its creation time, not the pull", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.upsertTranscriptionFromCloud({
    client_transcription_id: "pulled-history",
    id: "cloud-1",
    text: "three pulled words",
    status: "completed",
    created_at: "2026-03-04 08:00:00",
  });

  assert.equal(db.backfillAnalyticsHistoryBatch().inserted, 1);
  assert.equal(
    db.db.prepare("SELECT local_date FROM analytics_events WHERE event_id = 'pulled-history'").get()
      .local_date,
    localDateKey(new Date("2026-03-04T08:00:00Z"))
  );
});

test("backfill preserves the transcription creation time for retention", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.db
    .prepare(
      `INSERT INTO transcriptions (
         text, status, client_transcription_id, timestamp, created_at
       ) VALUES ('old words', 'completed', 'old-retained',
                 '2020-01-01T09:59:00.000Z', '2020-01-01 10:00:00')`
    )
    .run();

  assert.equal(db.backfillAnalyticsHistoryBatch().inserted, 1);
  assert.equal(
    db.db.prepare("SELECT created_at FROM analytics_events WHERE event_id = 'old-retained'").get()
      .created_at,
    "2020-01-01 10:00:00"
  );
  assert.equal(db.deleteTranscriptionsExpiredBefore(30).analyticsPurged, 1);
  assert.equal(db.getAnalyticsSummary().totalDictations, 0);
});

test("new transcription rows retain the original analytics occurrence time", (t) => {
  const db = createDb(t);
  if (!db) return;

  const occurredAt = "2026-09-01T09:58:00.000Z";
  const result = db.saveTranscription("saved words", "saved words", {
    analyticsOccurredAt: occurredAt,
  });
  assert.equal(result.transcription.timestamp, occurredAt.replace("T", " "));
});

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

  assert.equal(db.claimAnonymousAnalyticsEvents("account-b").success, false);
  assert.equal(db.countUnclaimedAnalyticsEvents(), 2, "another account cannot consume the claim");
  assert.equal(db.claimAnonymousAnalyticsEvents("account-a").claimed, 2);
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
