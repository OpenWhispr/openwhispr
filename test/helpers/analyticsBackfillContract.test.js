const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");

// Anchored on the method's own signature and the one that follows it, so the
// slice cannot silently widen to cover half the file.
function sliceBetween(startAnchor, endAnchor) {
  const start = source.indexOf(startAnchor);
  assert.notEqual(start, -1, `anchor not found: ${startAnchor}`);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  assert.notEqual(end, -1, `anchor not found after ${startAnchor}: ${endAnchor}`);
  return source.slice(start, end);
}

const ensureMethod = sliceBetween(
  "  async _ensureAnalyticsHistoryBackfilled()",
  "  // The dictation slot reports its own changes"
);

// Reconciliation runs ahead of every analytics read. Letting it reject means a
// failed scan blanks a summary SQLite could have answered: InsightsView treats
// a rejected getAnalyticsSummary as "reading local Insights failed" and shows
// the error state instead of the numbers it already has.
//
// The absorbing catch has to sit on the shared promise, not around the
// creator's await: a caller that arrives mid-pass is handed that promise
// directly, so a catch outside it protects only whoever started the scan.
test("a failed history backfill cannot fail the analytics read in front of it", () => {
  const joinReturn = ensureMethod.indexOf("return this._analyticsHistoryBackfillPromise;");
  const absorbingCatch = ensureMethod.indexOf(".catch((error) => {");
  assert.notEqual(joinReturn, -1, "joining callers must be handed the shared promise");
  assert.notEqual(absorbingCatch, -1, "the shared promise must absorb its own failure");
  assert.ok(
    absorbingCatch <
      ensureMethod.indexOf("this._analyticsHistoryBackfillPromise = backfillPromise"),
    "the catch must be attached before the promise is published to joining callers"
  );
  assert.equal(
    /catch \(error\) \{[\s\S]*?\bthrow\b/.test(ensureMethod),
    false,
    "the backfill must absorb its own failure rather than rethrow into the handler"
  );
});

// Without a checkpoint every analytics read re-walks the whole transcriptions
// table, including once per turn of AnalyticsService's upload loop.
test("a completed pass is not repeated on the next analytics read", () => {
  assert.ok(
    ensureMethod.includes("if (this._analyticsHistoryBackfilled) return"),
    "a finished backfill must short-circuit"
  );
  // Set before the scan so an invalidating write that lands mid-pass survives
  // it. Setting it after the loop would let the pass overwrite that write and
  // strand the row until the next process start.
  assert.ok(
    ensureMethod.indexOf("this._analyticsHistoryBackfilled = true") <
      ensureMethod.indexOf("backfillAnalyticsHistoryBatch"),
    "the checkpoint must be claimed before the scan, not after it"
  );
  // A joining caller must wait for the pass rather than read the checkpoint the
  // pass just claimed for itself.
  assert.ok(
    ensureMethod.indexOf("return this._analyticsHistoryBackfillPromise;") <
      ensureMethod.indexOf("if (this._analyticsHistoryBackfilled) return"),
    "an in-flight pass must be joined before the checkpoint is consulted"
  );
});

// The checkpoint is only sound if every write that can leave a completed
// transcription without an analytics event retires it. Each of these is sliced
// to its own handler so the assertion cannot be satisfied by a sibling's call.
test("every write that can strand a dictation retires the checkpoint", () => {
  const invalidator = "this._analyticsHistoryBackfilled = false;";

  const cloudPull = sliceBetween(
    'ipcMain.handle("db-upsert-transcription-from-cloud"',
    'ipcMain.handle("db-mark-transcription-synced"'
  );
  assert.ok(
    cloudPull.includes(invalidator),
    "a cloud pull brings history this device has never reconciled, and can flip a row to completed"
  );

  const retry = sliceBetween(
    'ipcMain.handle("retry-transcription"',
    "return { success: true, transcription: updated };"
  );
  assert.ok(
    retry.includes(invalidator),
    "a retry that reaches completed makes its own row eligible"
  );

  // The renderer only warns when the live write fails and still saves the
  // transcription, so this is the path that strands an ordinary dictation.
  const recordEvent = sliceBetween(
    'ipcMain.handle("analytics-record-event"',
    'ipcMain.handle("analytics-get-summary"'
  );
  assert.ok(
    recordEvent.includes(invalidator),
    "a live analytics write that throws leaves a completed row only the backfill will reconcile"
  );
});
