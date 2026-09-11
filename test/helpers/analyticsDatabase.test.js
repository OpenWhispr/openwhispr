const test = require("node:test");
const assert = require("node:assert/strict");

const { createDb } = require("./harness/db.js");
const DatabaseManager = require("../../src/helpers/database.js");
const {
  ANALYTICS_HISTORY_BACKFILL_VERSION,
  localDateKey,
} = require("../../src/helpers/analytics.js");

function reconcileThroughCheckpoint(db, limit = 250) {
  const state = db.getAnalyticsHistoryBackfillState(ANALYTICS_HISTORY_BACKFILL_VERSION);
  const batches = [];
  do {
    batches.push(
      db.backfillAnalyticsHistoryBatch({
        throughId: state.targetId,
        checkpointVersion: ANALYTICS_HISTORY_BACKFILL_VERSION,
        limit,
      })
    );
  } while (!batches[batches.length - 1].complete);
  return batches;
}

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
        counter_version: 0,
        created_at: "2026-09-02 10:00:00",
      },
      {
        event_id: "legacy-local",
        account_id: null,
        word_count: 3,
        spoken_duration_ms: 2_000,
        mode: "local",
        counter_version: 0,
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

test("analytics history checkpoint persists progress and scans only the new tail", (t) => {
  const db = createDb(t);
  if (!db) return;

  const insert = db.db.prepare(
    `INSERT INTO transcriptions (
       text, status, client_transcription_id, timestamp, created_at
     ) VALUES (?, 'completed', ?, ?, ?)`
  );
  insert.run("one two", "checkpoint-1", "2026-09-01T10:00:00.000Z", "2026-09-01 10:00:00");
  insert.run("three four", "checkpoint-2", "2026-09-02T10:00:00.000Z", "2026-09-02 10:00:00");

  assert.deepEqual(db.getAnalyticsHistoryBackfillState(), {
    version: ANALYTICS_HISTORY_BACKFILL_VERSION,
    scannedThroughId: 0,
    targetId: 2,
  });
  assert.equal(
    reconcileThroughCheckpoint(db, 1).reduce((total, batch) => total + batch.inserted, 0),
    2
  );
  assert.deepEqual(db.getAnalyticsHistoryBackfillState(), {
    version: ANALYTICS_HISTORY_BACKFILL_VERSION,
    scannedThroughId: 2,
    targetId: 2,
  });
  assert.deepEqual(reconcileThroughCheckpoint(db), [
    {
      complete: true,
      nextCursor: 2,
      scanned: 0,
      inserted: 0,
      skipped: 0,
    },
  ]);

  insert.run("five six", "checkpoint-3", "2026-09-03T10:00:00.000Z", "2026-09-03 10:00:00");
  assert.deepEqual(db.getAnalyticsHistoryBackfillState(), {
    version: ANALYTICS_HISTORY_BACKFILL_VERSION,
    scannedThroughId: 2,
    targetId: 3,
  });
  assert.equal(reconcileThroughCheckpoint(db)[0].inserted, 1);
  assert.equal(db.getAnalyticsSummary().totalDictations, 3);

  assert.deepEqual(db.getAnalyticsHistoryBackfillState(ANALYTICS_HISTORY_BACKFILL_VERSION + 1), {
    version: ANALYTICS_HISTORY_BACKFILL_VERSION + 1,
    scannedThroughId: 0,
    targetId: 3,
  });
});

test("a reopened database reuses its completed analytics history checkpoint", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.saveTranscription("persist this checkpoint", null, {
    clientTranscriptionId: "checkpoint-reopen",
    analyticsOccurredAt: "2026-09-01T10:00:00.000Z",
  });
  reconcileThroughCheckpoint(db);
  db.db.close();

  const reopened = new DatabaseManager();
  try {
    assert.deepEqual(reopened.getAnalyticsHistoryBackfillState(), {
      version: ANALYTICS_HISTORY_BACKFILL_VERSION,
      scannedThroughId: 1,
      targetId: 1,
    });
    assert.equal(reconcileThroughCheckpoint(reopened)[0].scanned, 0);
  } finally {
    reopened.db.close();
  }
});

test("schema setup adds the checkpoint table to an existing database without a migration", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.db.exec("DROP TABLE analytics_history_backfill_state");
  db.db.close();

  const reopened = new DatabaseManager();
  try {
    assert.deepEqual(reopened.getAnalyticsHistoryBackfillState(), {
      version: ANALYTICS_HISTORY_BACKFILL_VERSION,
      scannedThroughId: 0,
      targetId: 0,
    });
  } finally {
    reopened.db.close();
  }
});

test("older eligibility changes rewind the durable analytics checkpoint", (t) => {
  const db = createDb(t);
  if (!db) return;

  const failed = db.db
    .prepare(
      `INSERT INTO transcriptions (
         text, status, client_transcription_id, timestamp, created_at
       ) VALUES ('retry these words', 'failed', 'checkpoint-retry',
                 '2026-09-01T10:00:00.000Z', '2026-09-01 10:00:00')`
    )
    .run();
  db.db
    .prepare(
      `INSERT INTO transcriptions (
         text, status, client_transcription_id, timestamp, created_at
       ) VALUES ('already completed', 'completed', 'checkpoint-complete',
                 '2026-09-02T10:00:00.000Z', '2026-09-02 10:00:00')`
    )
    .run();
  const empty = db.db
    .prepare(
      `INSERT INTO transcriptions (
         text, status, client_transcription_id, timestamp, created_at
       ) VALUES ('', 'completed', 'checkpoint-empty',
                 '2026-09-03T10:00:00.000Z', '2026-09-03 10:00:00')`
    )
    .run();
  reconcileThroughCheckpoint(db);
  assert.equal(db.getAnalyticsHistoryBackfillState().scannedThroughId, 3);

  db.updateTranscriptionStatus(Number(failed.lastInsertRowid), "completed");
  assert.equal(db.getAnalyticsHistoryBackfillState().scannedThroughId, 0);
  assert.equal(reconcileThroughCheckpoint(db)[0].inserted, 1);

  const unchanged = db.getTranscriptionById(Number(failed.lastInsertRowid));
  db.upsertTranscriptionFromCloud({
    id: "cloud-retry",
    client_transcription_id: unchanged.client_transcription_id,
    text: unchanged.text,
    raw_text: unchanged.raw_text,
    status: unchanged.status,
    created_at: unchanged.created_at,
  });
  assert.equal(
    db.getAnalyticsHistoryBackfillState().scannedThroughId,
    3,
    "an unchanged cloud replay must not rewind the cursor"
  );

  db.upsertTranscriptionFromCloud({
    id: "cloud-retry",
    client_transcription_id: unchanged.client_transcription_id,
    text: "changed cloud text",
    raw_text: unchanged.raw_text,
    status: unchanged.status,
    created_at: unchanged.created_at,
  });
  assert.equal(db.getAnalyticsHistoryBackfillState().scannedThroughId, 0);
  reconcileThroughCheckpoint(db);

  db.updateTranscriptionText(Number(empty.lastInsertRowid), "now usable", null);
  assert.equal(db.getAnalyticsHistoryBackfillState().scannedThroughId, 2);
  assert.equal(reconcileThroughCheckpoint(db)[0].inserted, 1);
});

test("analytics history checkpoint advances atomically with each batch", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.db
    .prepare(
      `INSERT INTO transcriptions (
         text, status, client_transcription_id, timestamp, created_at
       ) VALUES
         ('first row', 'completed', 'atomic-1',
          '2026-09-01T10:00:00.000Z', '2026-09-01 10:00:00'),
         ('second row', 'completed', 'atomic-2',
          '2026-09-02T10:00:00.000Z', '2026-09-02 10:00:00')`
    )
    .run();
  const state = db.getAnalyticsHistoryBackfillState();
  const first = db.backfillAnalyticsHistoryBatch({
    throughId: state.targetId,
    checkpointVersion: ANALYTICS_HISTORY_BACKFILL_VERSION,
    limit: 1,
  });
  assert.equal(first.nextCursor, 1);
  db.db.exec("DROP TABLE analytics_events");

  assert.throws(
    () =>
      db.backfillAnalyticsHistoryBatch({
        throughId: state.targetId,
        checkpointVersion: ANALYTICS_HISTORY_BACKFILL_VERSION,
        limit: 1,
      }),
    /analytics_events/
  );
  assert.equal(db.getAnalyticsHistoryBackfillState().scannedThroughId, 1);
});

test("clearing history keeps old counters gone and admits later transcription IDs", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.saveTranscription("old checkpoint words", null, {
    clientTranscriptionId: "checkpoint-before-clear",
    analyticsOccurredAt: "2026-09-01T10:00:00.000Z",
  });
  reconcileThroughCheckpoint(db);
  assert.equal(db.getAnalyticsSummary().totalDictations, 1);

  db.clearTranscriptions();
  assert.equal(db.getAnalyticsSummary().totalDictations, 0);
  const afterClear = new Date(Date.now() + 60_000).toISOString();
  db.saveTranscription("new checkpoint words", null, {
    clientTranscriptionId: "checkpoint-after-clear",
    analyticsOccurredAt: afterClear,
  });
  assert.equal(reconcileThroughCheckpoint(db)[0].inserted, 1);
  assert.equal(db.getAnalyticsSummary().totalDictations, 1);
  assert.equal(
    db.db
      .prepare("SELECT COUNT(*) AS count FROM analytics_events WHERE event_id = ?")
      .get("checkpoint-before-clear").count,
    0
  );
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

test("pending analytics prioritize live events over historical rollback retries", (t) => {
  const db = createDb(t);
  if (!db) return;

  db.setActiveAccountId("account-a");
  recordEvent(db, "old-history", { occurredAt: "2026-01-01T09:00:00.000Z" });
  recordEvent(db, "new-live", { occurredAt: "2026-08-30T09:00:00.000Z" });
  db.db
    .prepare("UPDATE analytics_events SET counter_version = 0 WHERE event_id = 'old-history'")
    .run();

  assert.deepEqual(
    db.getPendingAnalyticsEvents(1).map((row) => row.event_id),
    ["new-live"],
    "an old API rejecting version-zero history must not hold live analytics behind it"
  );
});

test("a dictation pulled from the cloud is dated when it was spoken, not when it synced", (t) => {
  const db = createDb(t);
  if (!db) return;

  // The history list sorts on timestamp. Leaving cloud rows to default it makes
  // a whole pull land at "now" and sort above dictations spoken since, so an
  // old archive arrives on top of this morning's work.
  db.upsertTranscriptionFromCloud({
    client_transcription_id: "from-cloud",
    id: "cloud-1",
    text: "spoken last spring",
    created_at: "2026-04-01T09:00:00.000Z",
  });

  const [row] = db.getTranscriptions(10);
  assert.equal(row.client_transcription_id, "from-cloud");
  assert.equal(row.timestamp, "2026-04-01 09:00:00.000Z");
});

test("a cloud pull sorts by when it was spoken, in the shape the API actually sends", (t) => {
  const db = createDb(t);
  if (!db) return;

  // The API serializes transcriptions.created_at, a timestamptz, straight to
  // JSON, so it arrives ISO 8601 with a "T". The history list sorts timestamp
  // as TEXT and "T" (0x54) outranks the space (0x20) every locally written row
  // uses, so an unnormalized cloud value jumps above everything spoken on the
  // device that day regardless of the hour.
  db.saveTranscription("spoken here tonight", null, {
    clientTranscriptionId: "local-late",
    analyticsOccurredAt: "2026-04-01T23:00:00.000Z",
  });
  db.upsertTranscriptionFromCloud({
    client_transcription_id: "cloud-early",
    id: "cloud-2",
    text: "spoken elsewhere this morning",
    created_at: "2026-04-01T02:00:00.000Z",
  });

  assert.deepEqual(
    db.getTranscriptions(10).map((row) => row.client_transcription_id),
    ["local-late", "cloud-early"],
    "newest first, whichever writer stored the row"
  );
});

test("a cloud pull does not overwrite the local recording time it already has", (t) => {
  const db = createDb(t);
  if (!db) return;

  // The device that made the dictation recorded when speech started; the cloud
  // only knows when the row was created. The local value is the better one.
  db.saveTranscription("spoken here", null, {
    clientTranscriptionId: "local-first",
    analyticsOccurredAt: "2026-04-01T09:00:00.000Z",
  });
  db.upsertTranscriptionFromCloud({
    client_transcription_id: "local-first",
    id: "cloud-2",
    text: "spoken here, cleaned",
    created_at: "2026-04-02 17:30:00",
  });

  const [row] = db.getTranscriptions(10);
  assert.equal(row.timestamp, "2026-04-01 09:00:00.000Z");
  assert.equal(row.text, "spoken here, cleaned", "the pull still updates the transcript");
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
