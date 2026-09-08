const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "../../src/helpers/ipcHandlers.js"),
  "utf8"
);
const ensureMethod = source.slice(
  source.indexOf("  async _ensureAnalyticsHistoryBackfilled()"),
  source.indexOf("  // The dictation slot reports its own changes")
);

// Reconciliation runs ahead of every analytics read. Letting it reject means a
// failed scan blanks a summary SQLite could have answered: InsightsView treats
// a rejected getAnalyticsSummary as "reading local Insights failed" and shows
// the error state instead of the numbers it already has.
test("a failed history backfill cannot fail the analytics read in front of it", () => {
  assert.ok(ensureMethod.length > 0, "the slice must actually cover the method");
  assert.equal(
    /catch \(error\) \{[\s\S]*?\bthrow\b/.test(ensureMethod),
    false,
    "the backfill must absorb its own failure rather than rethrow into the handler"
  );
  assert.ok(
    ensureMethod.includes("return { inserted: 0, scanned: 0 };"),
    "a failed pass still has to answer its callers"
  );
});

// Without a checkpoint every analytics read re-walks the whole transcriptions
// table, including once per turn of AnalyticsService's upload loop.
test("a completed pass is not repeated on the next analytics read", () => {
  assert.ok(
    ensureMethod.includes(
      "if (this._analyticsHistoryBackfilledRevision === this._analyticsHistoryRevision)"
    ),
    "a finished backfill must short-circuit"
  );
  assert.ok(
    ensureMethod.indexOf("this._analyticsHistoryBackfilledRevision = startingRevision") >
      ensureMethod.indexOf("if (batch.complete) break;"),
    "the checkpoint may only be set once the scan has actually drained"
  );
  // Either invalidating write can land after the scan has read past the row it
  // changes, so a pass may only vouch for the revision it started from.
  assert.ok(
    ensureMethod.includes("const startingRevision = this._analyticsHistoryRevision;"),
    "the checkpoint must record the revision the scan started from, not the current one"
  );
});

// The checkpoint is only safe if everything that can add an eligible row
// retires it. A new dictation records its own event, so the writes that matter
// are a retry that lands and a transcription pulled from the cloud.
test("both writes that can add eligible history retire the checkpoint", () => {
  const pullHandler = source.slice(
    source.indexOf('ipcMain.handle("db-upsert-transcription-from-cloud"'),
    source.indexOf('ipcMain.handle("db-mark-transcription-synced"')
  );
  assert.ok(
    pullHandler.includes("this._analyticsHistoryRevision += 1"),
    "a cloud pull brings history this device has never reconciled"
  );

  const retryPath = source.slice(
    source.indexOf('broadcastToWindows("transcription-updated", updated)')
  );
  assert.ok(
    retryPath
      .slice(0, retryPath.indexOf("return { success: true, transcription: updated };"))
      .includes("this._analyticsHistoryRevision += 1"),
    "a retry that reaches completed makes its own row eligible"
  );
});
