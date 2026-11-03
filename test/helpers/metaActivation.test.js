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
  let wall = Date.parse("2026-10-14T10:00:00.000Z");
  let offline = false;
  let blocked = false;
  let permitted = true;
  let conflict = false;
  let loseAnswer = false;
  const calls = [];
  const warnings = [];
  let seq = 0;
  let total = 0;
  let device = null;
  const contributions = new Map();
  // Mirrors recordActivationBatch's watermark and contribution checks.
  const rejects = (body) =>
    !body.gap &&
    (Date.parse(body.completeThrough) > wall + 30_000 ||
      Date.parse(body.completeThrough) < Date.parse(device.complete_through) ||
      body.events.some((e) => {
        if (e.seq <= seq) {
          const old = contributions.get(e.seq);
          return (
            !old ||
            old.eventId !== e.eventId ||
            old.words !== e.words ||
            Date.parse(old.occurredAt) !== Date.parse(e.occurredAt)
          );
        }
        return (
          Date.parse(e.occurredAt) <= Date.parse(device.complete_through) ||
          Date.parse(e.occurredAt) > Date.parse(body.completeThrough)
        );
      }));
  const request = async ({ path, body }) => {
    calls.push({ path, body: structuredClone(body) });
    if (offline) throw new Error("offline");
    if (blocked) return { success: false, status: 403, code: "POLICY_CLOUD_BACKUP_BLOCKED" };
    const serverTime = new Date(wall).toISOString();
    if (path.endsWith("/device") && !permitted)
      return { success: true, data: { status: "awaiting_permission", serverTime, device: null } };
    if (path.endsWith("/device")) {
      device ??= { registered_at: serverTime, complete_through: serverTime, closed: false };
      return {
        success: true,
        data: { status: "collecting", serverTime, device: { ...device, last_seq: seq } },
      };
    }
    if (conflict || rejects(body)) {
      calls.at(-1).status = 409;
      return { success: false, status: 409, error: "Activation stream could not be reconciled" };
    }
    for (const e of body.events)
      if (e.seq > seq) {
        contributions.set(e.seq, structuredClone(e));
        seq = e.seq;
        total += e.words;
      }
    if (!body.gap) device.complete_through = body.completeThrough;
    // Committed, but the answer never arrives (the 10 s abort).
    if (loseAnswer) throw new Error("timeout");
    return {
      success: true,
      data: { status: total >= 200 ? "pending" : "collecting", acceptedThrough: seq },
    };
  };
  const logger = { warn: (message) => warnings.push(message), debug: () => {} };
  const create = () =>
    new MetaActivation({ db, getScope: () => scope, request, monotonicNow: () => clock, logger });
  const manager = create();
  return {
    db,
    manager,
    create,
    calls,
    warnings,
    tick: (n = 1000) => {
      clock += n;
      wall += n;
    },
    // The monotonic clock runs `ahead` ms faster than server time over `n` ms.
    drift: (n, ahead) => {
      clock += n + ahead;
      wall += n;
    },
    wall: () => wall,
    offline: (v) => (offline = v),
    blocked: (v) => (blocked = v),
    permitted: (v) => (permitted = v),
    conflict: (v) => (conflict = v),
    loseAnswer: (v) => (loseAnswer = v),
    device: () => device,
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

const batches = (r) => r.calls.filter((c) => c.path.endsWith("/batch"));
const registrations = (r) => r.calls.filter((c) => c.path.endsWith("/device")).length;

test("an hourly re-sync preserves future captures until server time catches up", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  // 40 s ahead after an hour: one batch from this clock is past the 30 s window.
  r.drift(60 * 60_000, 40_000);
  assert.ok(r.manager.clock(r.manager.getScope()) > r.wall() + 30_000);
  await capture(r, 5);
  assert.equal(registrations(r), 2);
  const original = batches(r).at(-1).body.events[0];
  assert.equal(batches(r).at(-1).status, 409);
  assert.equal(r.db.prepare("SELECT count(*) n FROM captures").get().n, 1);
  r.tick(30_000);
  await r.manager.flush();
  const batch = batches(r).at(-1);
  assert.equal(batch.status, undefined);
  assert.deepEqual(batch.body.events[0], original);
  assert.ok(Date.parse(batch.body.completeThrough) <= r.wall() + 30_000);
  assert.equal(batch.body.gap, false);
  assert.equal(r.manager.current().total_words, 5);
  assert.equal(r.db.prepare("SELECT count(*) n FROM captures").get().n, 0);
});
test("a clock past its hourly re-sync still stamps dictation and sends it once refreshed", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  r.drift(2 * 60 * 60_000, 50_000);
  r.offline(true);
  await capture(r, 3);
  assert.equal(r.manager.current().gap, 0);
  r.offline(false);
  await r.manager.flush();
  assert.equal(batches(r).at(-1).status, 409);
  r.tick(30_000);
  await r.manager.flush();
  assert.equal(batches(r).at(-1).status, undefined);
  assert.equal(batches(r).at(-1).body.events[0].words, 3);
  assert.equal(r.manager.current().gap, 0);
});
test("waking from sleep re-syncs the clock before the next batch", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  r.drift(10 * 60_000, 40_000);
  await r.manager.resync();
  assert.deepEqual(
    r.calls.slice(-2).map((c) => c.path),
    ["/api/activation/device", "/api/activation/batch"]
  );
  assert.equal(batches(r).at(-1).status, undefined);
});
test("a rejected batch re-syncs once instead of resending the same watermark", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  r.drift(10 * 60_000, 40_000);
  await r.manager.flush();
  assert.equal(batches(r).at(-1).status, 409);
  await r.manager.flush();
  assert.deepEqual(
    r.calls.slice(-2).map((c) => c.path),
    ["/api/activation/device", "/api/activation/batch"]
  );
  assert.equal(batches(r).at(-1).status, undefined);
  r.drift(10 * 60_000, 40_000);
  await r.manager.flush();
  assert.equal(batches(r).at(-1).status, 409);
  assert.deepEqual(r.warnings, ["Activation batch rejected; clock re-synced"]);
  await capture(r, 7);
  assert.equal(batches(r).at(-1).status, 409);
  r.tick(30_000);
  await r.manager.flush();
  assert.equal(batches(r).at(-1).status, undefined);
  assert.equal(r.manager.current().gap, 0);
});
test("a re-sync that moves the clock back never stamps at or before the acknowledged watermark", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  // Accepted while 25 s ahead, so the server's watermark is ahead of server time.
  r.drift(10 * 60_000, 25_000);
  await r.manager.flush();
  const watermark = Date.parse(r.manager.current().complete_through);
  assert.ok(watermark > r.wall());
  await r.manager.resync();
  assert.ok(r.manager.clock(r.manager.getScope()) < watermark);
  const id = r.manager.begin();
  r.manager.stopCapture(id);
  r.manager.finish(id, 4);
  await r.manager.flush();
  const event = batches(r).at(-1).body.events[0];
  assert.ok(Date.parse(event.occurredAt) > watermark);
  assert.equal(batches(r).at(-1).status, undefined);
  assert.equal(r.manager.current().total_words, 4);
});
test("a 409 a fresh clock does not fix re-syncs once, not on every pass", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  r.conflict(true);
  await capture(r, 2);
  assert.equal(batches(r).at(-1).status, 409);
  const before = r.calls.length;
  for (let i = 0; i < 4; i++) await r.manager.flush();
  assert.deepEqual(
    r.calls.slice(before).map((c) => c.path),
    [
      "/api/activation/device",
      "/api/activation/batch",
      "/api/activation/batch",
      "/api/activation/batch",
      "/api/activation/batch",
    ]
  );
  r.conflict(false);
  await r.manager.flush();
  assert.equal(batches(r).at(-1).status, undefined);
  assert.equal(r.manager.current().total_words, 2);
  assert.deepEqual(r.warnings, ["Activation batch rejected; clock re-synced"]);
});
test("waking an unenrolled device posts nothing", async (t) => {
  const r = rig(t);
  r.permitted(false);
  await r.manager.flush();
  await r.manager.resync();
  assert.equal(r.calls.length, 1);
});
test("contribution replays preserve their event id, words and timestamp", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  await capture(r, 2);
  const { path, body } = batches(r).at(-1);
  assert.equal((await r.manager.request({ path, body })).success, true);
  for (const change of [
    { eventId: "different" },
    { words: 3 },
    { occurredAt: new Date(Date.parse(body.events[0].occurredAt) - 1).toISOString() },
  ]) {
    const replay = structuredClone(body);
    Object.assign(replay.events[0], change);
    assert.equal((await r.manager.request({ path, body: replay })).status, 409);
  }
});
test("a timed-out batch committed after a registration snapshot replays unchanged after restart", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  r.drift(10 * 60_000, 25_000);
  const request = r.manager.request;
  let delayed;
  r.manager.request = async (req) => {
    delayed = structuredClone(req);
    r.tick(10_000);
    throw new Error("timeout");
  };
  const id = r.manager.begin();
  r.tick();
  r.manager.stopCapture(id);
  r.tick(3000);
  r.manager.finish(id, 2);
  await r.manager.flush();
  const original = delayed.body.events[0];
  const restarted = r.create();
  let committed = false;
  restarted.request = async (req) => {
    const response = await request(req);
    if (!committed && req.path.endsWith("/device")) {
      assert.equal(response.data.device.last_seq, 0);
      assert.equal((await request(delayed)).success, true);
      committed = true;
    }
    return response;
  };
  await restarted.flush();
  // The late commit advanced the watermark past the capture's stop time.
  assert.equal(batches(r).at(-1).status, 409);
  await restarted.flush();
  assert.equal(batches(r).at(-1).status, undefined);
  for (const batch of batches(r).filter((c) => c.body.events.length))
    assert.deepEqual(batch.body.events[0], original);
  assert.equal(r.db.prepare("SELECT count(*) n FROM captures").get().n, 0);
  assert.equal(restarted.current().total_words, 2);
  assert.equal(restarted.current().complete_through, r.device().complete_through);
});
test("a lost acknowledgement followed by a backward re-sync never lands behind the server", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  r.drift(10 * 60_000, 25_000);
  r.loseAnswer(true);
  const id = r.manager.begin();
  r.tick();
  r.manager.stopCapture(id);
  // Transcription takes a few seconds, so the watermark passes the stop time.
  r.tick(3000);
  r.manager.finish(id, 2);
  await r.manager.flush();
  r.loseAnswer(false);
  const sent = batches(r).length;
  await r.manager.resync();
  await capture(r, 3);
  assert.deepEqual(
    batches(r)
      .slice(sent)
      .map((c) => c.status),
    [undefined, undefined]
  );
  assert.equal(r.manager.current().total_words, 5);
  assert.equal(r.manager.current().complete_through, r.device().complete_through);
});
test("closing after an hour sends only the closing batch", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  r.tick(61 * 60_000);
  const before = r.calls.length;
  await r.manager.close();
  assert.deepEqual(
    r.calls.slice(before).map((c) => c.path),
    ["/api/activation/batch"]
  );
  assert.equal(r.calls.at(-1).body.close, true);
  assert.equal(r.manager.current().state, "closed");
});
test("an unsent capture stamped behind the server's watermark is restamped past it", async (t) => {
  const r = rig(t);
  await r.manager.flush();
  r.drift(10 * 60_000, 25_000);
  r.loseAnswer(true);
  await capture(r, 2);
  r.loseAnswer(false);
  // An older build restarted on true time and stamped behind the server's
  // watermark, which it never learned.
  const watermark = Date.parse(r.device().complete_through);
  const stream = r.manager.current();
  r.db
    .prepare(
      "INSERT INTO captures(id,stream_id,generation,started_at,occurred_at,seq,words) VALUES('behind',?,1,?,?,?,3)"
    )
    .run(
      stream.id,
      new Date(r.wall() - 1).toISOString(),
      new Date(r.wall()).toISOString(),
      stream.last_seq + 1
    );
  r.db
    .prepare("UPDATE streams SET last_seq=last_seq+1,total_words=total_words+3 WHERE id=?")
    .run(stream.id);
  assert.ok(r.wall() < watermark);
  await r.create().flush();
  const event = batches(r)
    .at(-1)
    .body.events.find((e) => e.eventId === "behind");
  assert.ok(Date.parse(event.occurredAt) > watermark);
  assert.equal(batches(r).at(-1).status, undefined);
  assert.equal(r.manager.current().total_words, 5);
});
