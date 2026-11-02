const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { MetaActivation } = require("../../src/helpers/metaActivation");
const { loadAudioManager } = require("./harness/audioManager");

function rig(t) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  t.after(() => {
    if (db.open) db.close();
  });
  let scope = { accountId: "a", authGeneration: 1 };
  let clock = 0;
  let offline = false;
  let blocked = false;
  let permitted = true;
  const calls = [];
  let seq = 0;
  let total = 0;
  const serverTime = "2026-10-14T10:00:00.000Z";
  const request = async ({ path, body }) => {
    calls.push({ path, body: structuredClone(body) });
    if (offline) throw new Error("offline");
    if (blocked) return { success: false, status: 403, code: "POLICY_CLOUD_BACKUP_BLOCKED" };
    if (path.endsWith("/device") && !permitted)
      return { success: true, data: { status: "awaiting_permission", serverTime, device: null } };
    if (path.endsWith("/device"))
      return {
        success: true,
        data: {
          status: "collecting",
          serverTime,
          device: {
            registered_at: serverTime,
            complete_through: serverTime,
            last_seq: seq,
            closed: false,
          },
        },
      };
    for (const e of body.events)
      if (e.seq > seq) {
        seq = e.seq;
        total += e.words;
      }
    return {
      success: true,
      data: { status: total >= 200 ? "pending" : "collecting", acceptedThrough: seq },
    };
  };
  const create = () =>
    new MetaActivation({ db, getScope: () => scope, request, monotonicNow: () => clock });
  const manager = create();
  return {
    db,
    manager,
    create,
    calls,
    tick: (n = 1000) => (clock += n),
    offline: (v) => (offline = v),
    blocked: (v) => (blocked = v),
    permitted: (v) => (permitted = v),
    scope: (v) => (scope = v),
  };
}
async function capture(r, words) {
  r.tick();
  const id = r.manager.begin();
  r.tick();
  r.manager.stopCapture(id);
  r.manager.finish(id, words);
  await r.manager.flush();
  return id;
}
test("durable queue sends 199 then 1, caps expansion, and retires at the server milestone", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  await capture(r, 199);
  await capture(r, 999);
  assert.deepEqual(
    r.calls
      .filter((c) => c.path.endsWith("batch"))
      .flatMap((c) => c.body.events)
      .map((e) => e.words),
    [199, 1]
  );
  assert.equal(r.manager.begin(), null);
  assert.equal(r.db.prepare("SELECT count(*) n FROM captures").get().n, 0);
});
test("offline retry/restart retains original event id and occurrence time", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  r.offline(true);
  await capture(r, 199);
  const original = r.calls.at(-1).body.events[0];
  const restarted = r.create();
  r.offline(false);
  await restarted.flush();
  assert.deepEqual(r.calls.at(-1).body.events[0], original);
});
test("unresolved recognition fences watermarks and cancelled work adds no words", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  r.tick();
  const id = r.manager.begin();
  r.tick();
  r.manager.stopCapture(id);
  const before = r.calls.length;
  await r.manager.flush();
  assert.equal(r.calls.length, before);
  r.manager.cancel(id);
  await r.manager.flush();
  assert.equal(r.calls.at(-1).body.events.length, 0);
});
test("account replacement cannot adopt a capture or acknowledge its old queue", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  r.tick();
  const id = r.manager.begin();
  r.tick();
  r.manager.stopCapture(id);
  r.scope({ accountId: "b", authGeneration: 2 });
  r.manager.finish(id, 200);
  await r.manager.flush();
  assert.equal(
    r.db.prepare("SELECT total_words,gap FROM streams WHERE account_id='a'").get().total_words,
    0
  );
  assert.equal(r.db.prepare("SELECT gap FROM streams WHERE account_id='a'").get().gap, 1);
  assert.equal(r.calls.filter((c) => c.body.events).flatMap((c) => c.body.events).length, 0);
});
test("offline process restart cannot fabricate a source time from a stale monotonic clock", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  const restarted = r.create();
  r.offline(true);
  assert.equal(restarted.begin(), null);
  assert.equal(r.db.prepare("SELECT gap FROM streams").get().gap, 1);
});
test("close proves stream complete; account erasure removes all dedicated local state", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  await capture(r, 3);
  await r.manager.close();
  assert.equal(r.calls.at(-1).body.close, true);
  r.manager.purge("a");
  assert.equal(r.db.prepare("SELECT count(*) n FROM streams").get().n, 0);
});
test("live capture counts original speech with history off, excluding assistant/output-only text", async (t) => {
  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "activation-raw-",
    settingsKey: "__activationSettings",
    settings: { dataRetentionEnabled: false },
  });
  const counts = [];
  window.electronAPI.finishActivationCapture = async (id, words) => counts.push({ id, words });
  const manager = createManager();
  await manager._completeActivationCapture("local", {
    success: true,
    rawText: "one",
    text: "expanded ".repeat(300),
  });
  await manager._completeActivationCapture("cloud", {
    success: true,
    rawText: "one two",
    text: "expanded ".repeat(300),
  });
  await manager._completeActivationCapture("assistant", {
    success: true,
    rawText: "one two",
    assistantConversation: {},
  });
  await manager._completeActivationCapture("output-only", {
    success: true,
    text: "expanded ".repeat(300),
  });
  assert.deepEqual(counts, [
    { id: "local", words: 1 },
    { id: "cloud", words: 2 },
    { id: "assistant", words: 0 },
    { id: "output-only", words: 0 },
  ]);
});

test("dictation before registration stays outside the prospective tracked count", async (t) => {
  const r = rig(t);
  assert.equal(r.manager.begin(), null);
  await r.manager.flush();
  assert.equal(r.calls.at(-1).body.gap, false);
  assert.deepEqual(r.calls.at(-1).body.events, []);
  await capture(r, 199);
  assert.equal(r.manager.current().total_words, 199);
});
test("an unenrolled device registers on dictation, not on the 30 s timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const r = rig(t);
  r.permitted(false);
  r.manager.start();
  await r.manager.flush();
  t.mock.timers.tick(90_000);
  await r.manager.running;
  await r.manager.close();
  assert.equal(r.calls.length, 1);
  r.permitted(true);
  assert.equal(r.manager.begin(), null);
  await r.manager.flush();
  assert.equal(r.manager.current().state, "open");
});
test("the timer retries a registration whose answer was lost", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const r = rig(t);
  r.offline(true);
  r.manager.start();
  await r.manager.flush();
  r.offline(false);
  t.mock.timers.tick(30_000);
  await r.manager.running;
  assert.equal(r.manager.current().state, "open");
});
test("a 403 quiets the timer only for an unregistered stream", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const r = rig(t);
  const tick = async () => {
    t.mock.timers.tick(30_000);
    await r.manager.running;
  };
  r.blocked(true);
  r.manager.start();
  await r.manager.flush();
  await tick();
  assert.equal(r.calls.length, 1);
  r.blocked(false);
  await r.manager.flush();
  r.blocked(true);
  await r.manager.flush();
  r.blocked(false);
  await tick();
  assert.deepEqual(
    r.calls.slice(3).map((c) => c.path),
    ["/api/activation/batch", "/api/activation/batch"]
  );
});
test("storage failure cannot be erased by finalizer cancellation or clean shutdown", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  r.tick();
  const id = r.manager.begin();
  r.tick();
  r.manager.stopCapture(id);
  r.db.exec(
    "CREATE TRIGGER fail_result BEFORE UPDATE OF words ON captures BEGIN SELECT RAISE(ABORT, 'disk full'); END;"
  );
  assert.throws(() => r.manager.finish(id, 200));
  r.manager.cancel(id);
  assert.equal(r.db.prepare("SELECT count(*) n FROM captures WHERE words IS NULL").get().n, 1);
  await r.manager.close();
  assert.equal(r.calls.at(-1).body.gap, true);
});

test("clean quit with unfinished recognition reports a coverage gap", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  r.tick();
  const id = r.manager.begin();
  r.tick();
  r.manager.stopCapture(id);
  await r.manager.close();
  assert.equal(r.calls.at(-1).body.gap, true);
});
test("device erasure closes queue database and disables future sync", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  r.manager.dispose();
  assert.equal(r.db.open, false);
  const before = r.calls.length;
  await r.manager.flush();
  assert.equal(r.calls.length, before);
});
test("cancellation during activation IPC cannot restart streaming or retain its late capture", async (t) => {
  const { window, createManager } = await loadAudioManager(t, {
    cachePrefix: "activation-cancel-",
    settingsKey: "__activationCancel",
    settings: {},
  });
  let resolveBegin;
  const cancelled = [];
  window.electronAPI.beginActivationCapture = () =>
    new Promise((resolve) => (resolveBegin = resolve));
  window.electronAPI.cancelActivationCapture = async (id) => cancelled.push(id);
  const manager = createManager({
    micRecovery: { stop() {} },
    cleanupStreamingAudio() {},
    cleanupStreamingListeners() {},
    cleanupPreview: async () => {},
    getStreamingProvider: () => ({ stop: async () => {} }),
    _streamingCancellationGeneration: 0,
    _streamingStartSettlementWaiters: [],
  });
  manager.isRecordingAllowedByPolicy = () => true;
  const starting = manager.startStreamingRecording();
  await Promise.resolve();
  const cancelling = manager.cancelStreamingRecording();
  resolveBegin("late-capture");
  assert.equal(await starting, false);
  await cancelling;
  assert.deepEqual(cancelled, ["late-capture"]);
  assert.equal(manager._activationCapture ?? null, null);
  assert.equal(manager.streamingStartInProgress, false);
});

test("close waits for a closing acknowledgement, not an earlier open batch", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  const original = r.manager.request;
  let release;
  let hold = true;
  const flags = [];
  r.manager.request = async (req) => {
    if (req.path.endsWith("/batch")) {
      flags.push(req.body.close);
      if (hold) {
        hold = false;
        await new Promise((resolve) => (release = resolve));
      }
    }
    return original(req);
  };
  const flushing = r.manager.flush();
  const closing = r.manager.close();
  release();
  await Promise.all([flushing, closing]);
  assert.deepEqual(flags, [false, true]);
  assert.equal(r.manager.current().state, "closed");
});
test("erasing an account's failed capture cannot suppress another account", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  r.tick();
  const id = r.manager.begin();
  r.tick();
  r.manager.stopCapture(id);
  r.db.exec(
    "CREATE TRIGGER fail_a BEFORE UPDATE OF words ON captures BEGIN SELECT RAISE(ABORT, 'disk full'); END;"
  );
  assert.throws(() => r.manager.finish(id, 10));
  r.manager.purge("a");
  r.db.exec("DROP TRIGGER fail_a;");
  r.scope({ accountId: "b", authGeneration: 2 });
  await r.manager.flush();
  await r.manager.close();
  assert.equal(r.calls.at(-1).body.gap, false);
  assert.equal(r.manager.failedCaptures.size, 0);
});

test("excluded assistant capture still honors immediate startup cancellation", async (t) => {
  const { createManager } = await loadAudioManager(t, {
    cachePrefix: "activation-assistant-cancel-",
    settingsKey: "__activationAssistantCancel",
    settings: {},
  });
  const states = [];
  const manager = createManager({
    voiceAgentRequested: true,
    micRecovery: { stop() {} },
    cleanupStreamingAudio() {},
    cleanupStreamingListeners() {},
    cleanupPreview: async () => {},
    getStreamingProvider: () => ({ stop: async () => {} }),
    _streamingCancellationGeneration: 0,
    _streamingStartSettlementWaiters: [],
    isRecordingAllowedByPolicy: () => true,
    onStateChange: (state) => states.push(state),
  });
  const start = manager.startStreamingRecording();
  const cancel = manager.cancelStreamingRecording();
  assert.deepEqual(await Promise.all([start, cancel]), [false, true]);
  assert.equal(
    states.some((state) => state.isRecording),
    false
  );
});
