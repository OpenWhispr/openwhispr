const test = require("node:test");
const assert = require("node:assert/strict");

const IPCHandlers = require("../../src/helpers/ipcHandlers");

function completeBatch(overrides = {}) {
  return {
    complete: true,
    nextCursor: 0,
    scanned: 0,
    inserted: 0,
    skipped: 0,
    ...overrides,
  };
}

function createContext(backfillAnalyticsHistoryBatch, targetId = 10) {
  const state = { scannedThroughId: 0, targetId };
  return Object.assign(Object.create(IPCHandlers.prototype), {
    databaseManager: {
      getAnalyticsHistoryBackfillState: () => ({ version: 1, ...state }),
      backfillAnalyticsHistoryBatch: (options) => {
        const result = backfillAnalyticsHistoryBatch({
          ...options,
          afterId: state.scannedThroughId,
        });
        state.scannedThroughId = result.complete ? state.targetId : result.nextCursor;
        return result;
      },
    },
    _analyticsHistoryBackfillPromise: null,
    _retentionSettings: { dataRetentionEnabled: true },
    _retentionSettingsSynced: true,
    analyticsHistoryBackfillState: state,
  });
}

test("history is not reconstructed until the renderer reports the retention setting", async () => {
  let scans = 0;
  const context = createContext(() => {
    scans += 1;
    return completeBatch({ nextCursor: 10 });
  });
  // The main process boots with defaults, not the user's choice, so before the
  // first sync it cannot know whether local history is allowed at all.
  context._retentionSettingsSynced = false;

  await context._ensureAnalyticsHistoryBackfilled();

  assert.equal(scans, 0, "an unsynced retention setting must not be read as consent");
});

test("history is not reconstructed while local history is turned off", async () => {
  let scans = 0;
  const context = createContext(() => {
    scans += 1;
    return completeBatch({ nextCursor: 10 });
  });
  // The live dictation path skips both the transcript and its counter when this
  // is off (audioManager.saveTranscription). Mining the transcripts already on
  // disk for counters would record exactly what the user turned off.
  context._retentionSettings = { dataRetentionEnabled: false };

  await context._ensureAnalyticsHistoryBackfilled();

  assert.equal(scans, 0, "reconstruction must honour the gate the live path honours");
});

test("a failed history pass is absorbed and remains retryable", async () => {
  let attempts = 0;
  const context = createContext(() => {
    attempts += 1;
    if (attempts === 1) throw new Error("broken history row");
    return completeBatch({ nextCursor: 1 });
  }, 1);

  assert.deepEqual(await context._ensureAnalyticsHistoryBackfilled(), {
    inserted: 0,
    scanned: 0,
  });
  assert.deepEqual(await context._ensureAnalyticsHistoryBackfilled(), {
    inserted: 0,
    scanned: 0,
  });
  assert.equal(attempts, 2);
});

test("concurrent readers share one pass and completed history stays checkpointed", async () => {
  let calls = 0;
  const context = createContext(({ afterId }) => {
    calls += 1;
    return afterId === 0
      ? completeBatch({ complete: false, nextCursor: 5, scanned: 1 })
      : completeBatch({ nextCursor: 10, scanned: 1 });
  });

  const first = context._ensureAnalyticsHistoryBackfilled();
  const joining = context._ensureAnalyticsHistoryBackfilled();
  assert.deepEqual(await Promise.all([first, joining]), [
    { inserted: 0, scanned: 2 },
    { inserted: 0, scanned: 2 },
  ]);
  assert.equal(calls, 2, "joining the pass must not start a second scan");

  assert.deepEqual(await context._ensureAnalyticsHistoryBackfilled(), {
    inserted: 0,
    scanned: 0,
  });
  assert.equal(calls, 2, "a completed pass must short-circuit later reads");
});

test("history is not reconstructed while an account's policy is still resolving", async () => {
  let calls = 0;
  const context = createContext(() => {
    calls += 1;
    return completeBatch();
  });
  // Signed in, so a workspace could still force local history off; the renderer
  // has only reported its own permissive default so far.
  context._hasActiveAccountScope = () => true;
  context._retentionSettings = { dataRetentionEnabled: true, localHistoryPolicyResolved: false };

  await context._ensureAnalyticsHistoryBackfilled();

  assert.equal(calls, 0, "a default is not consent while a managed policy may still arrive");
});

test("history is reconstructed for a signed-out user, whose policy never resolves", async () => {
  let calls = 0;
  const context = createContext(() => {
    calls += 1;
    return completeBatch({ scanned: 1 });
  });
  // No account, so the policy store stays idle forever and the user's own
  // preference is the only authority there is.
  context._hasActiveAccountScope = () => false;
  context._retentionSettings = { dataRetentionEnabled: true, localHistoryPolicyResolved: false };

  await context._ensureAnalyticsHistoryBackfilled();

  assert.equal(calls, 1, "an unresolvable policy must not disable the feature");
});

test("revoking local history stops a pass that is already scanning", async () => {
  let calls = 0;
  let context;
  context = createContext(() => {
    calls += 1;
    // The renderer's retention sync lands between the first batch and the
    // second, which is the only window a yielding scan leaves open.
    if (calls === 1) context._retentionSettings = { dataRetentionEnabled: false };
    // A pass that ignores the switch keeps mining until the history runs out.
    return completeBatch({ complete: calls >= 5, nextCursor: calls, scanned: 1 });
  });

  await context._ensureAnalyticsHistoryBackfilled();

  assert.equal(calls, 1, "the scan must stop at the next batch boundary, not run to the end");
});

test("an in-flight pass rereads a durable cursor that moves backward", async () => {
  let calls = 0;
  const starts = [];
  const context = createContext(({ afterId }) => {
    calls += 1;
    starts.push(afterId);
    return afterId < 5
      ? completeBatch({ complete: false, nextCursor: 5, scanned: 1 })
      : completeBatch({ nextCursor: 10, scanned: 1 });
  });

  const inFlight = context._ensureAnalyticsHistoryBackfilled();
  context.analyticsHistoryBackfillState.scannedThroughId = 0;
  await inFlight;
  assert.equal(calls, 3, "the regressed cursor must be revisited before the pass completes");
  assert.deepEqual(starts, [0, 0, 5]);
});
