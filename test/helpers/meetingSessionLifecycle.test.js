const test = require("node:test");
const assert = require("node:assert/strict");

const { MeetingSessionLifecycle } = require("../../src/helpers/meetingSessionLifecycle");
const { resolveMeetingNoteIdentity } = require("../../src/helpers/meetingDiarizationPersistence");

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("a new meeting cannot replace session ownership while the previous stop is suspended", async () => {
  const lifecycle = new MeetingSessionLifecycle();
  const releaseStop = deferred();
  const events = [];
  let activeIdentity = null;
  let stoppedIdentity = null;

  await lifecycle.start(async () => {
    activeIdentity = { noteId: 1, clientNoteId: "client-a" };
    events.push("start-a");
  });

  const stopA = lifecycle.stop(async () => {
    stoppedIdentity = { ...activeIdentity };
    events.push("stop-a-begin");
    await releaseStop.promise;
    events.push(`stop-a-end:${stoppedIdentity.clientNoteId}`);
  });

  await Promise.resolve();
  const startB = lifecycle.start(async () => {
    activeIdentity = { noteId: 2, clientNoteId: "client-b" };
    events.push("start-b");
  });

  await Promise.resolve();
  assert.equal(lifecycle.isStopping, true);
  assert.deepEqual(activeIdentity, { noteId: 1, clientNoteId: "client-a" });
  assert.deepEqual(events, ["start-a", "stop-a-begin"]);

  releaseStop.resolve();
  await Promise.all([stopA, startB]);

  assert.deepEqual(stoppedIdentity, { noteId: 1, clientNoteId: "client-a" });
  assert.deepEqual(activeIdentity, { noteId: 2, clientNoteId: "client-b" });
  assert.deepEqual(events, ["start-a", "stop-a-begin", "stop-a-end:client-a", "start-b"]);
  assert.equal(lifecycle.isStopping, false);
});

test("a stop queued after the next start is not deduplicated with the previous session's stop", async () => {
  const lifecycle = new MeetingSessionLifecycle();
  const releaseStopA = deferred();
  const events = [];

  await lifecycle.start(() => events.push("start-a"));
  const stopA = lifecycle.stop(async () => {
    events.push("stop-a");
    await releaseStopA.promise;
  });
  const startB = lifecycle.start(() => events.push("start-b"));
  const stopB = lifecycle.stop(() => events.push("stop-b"));

  assert.notEqual(stopA, stopB);
  releaseStopA.resolve();
  await Promise.all([stopA, startB, stopB]);

  assert.deepEqual(events, ["start-a", "stop-a", "start-b", "stop-b"]);
  assert.equal(lifecycle.isStopping, false);
});

test("a queued start fails closed if its numeric note id is reused before it runs", async () => {
  const lifecycle = new MeetingSessionLifecycle();
  const releaseStop = deferred();
  const rows = new Map([
    [1, { id: 1, client_note_id: "client-a", deleted_at: null }],
    [2, { id: 2, client_note_id: "client-b", deleted_at: null }],
  ]);
  const databaseManager = { getNote: (id) => rows.get(id) ?? null };
  let activeIdentity = null;

  await lifecycle.start(() => {
    activeIdentity = resolveMeetingNoteIdentity(databaseManager, 1, "client-a");
  });
  const stopA = lifecycle.stop(() => releaseStop.promise);
  const startB = lifecycle.start(() => {
    const identity = resolveMeetingNoteIdentity(databaseManager, 2, "client-b");
    if (!identity) throw new Error("Meeting note changed before recording could start");
    activeIdentity = identity;
  });

  rows.set(2, { id: 2, client_note_id: "replacement", deleted_at: null });
  releaseStop.resolve();
  await stopA;

  await assert.rejects(startB, /Meeting note changed/);
  assert.deepEqual(activeIdentity, { noteId: 1, clientNoteId: "client-a" });
});

test("pre-warming is serialized between stop and the next start", async () => {
  const lifecycle = new MeetingSessionLifecycle();
  const releaseStop = deferred();
  const events = [];

  await lifecycle.start(() => events.push("start-a"));
  const stopA = lifecycle.stop(async () => {
    events.push("stop-a");
    await releaseStop.promise;
  });
  const prepareB = lifecycle.run(() => events.push("prepare-b"));
  const startB = lifecycle.start(() => events.push("start-b"));

  await Promise.resolve();
  assert.deepEqual(events, ["start-a", "stop-a"]);
  releaseStop.resolve();
  await Promise.all([stopA, prepareB, startB]);

  assert.deepEqual(events, ["start-a", "stop-a", "prepare-b", "start-b"]);
});

test("pre-warming does not make a duplicate stop look like a new session stop", async () => {
  const lifecycle = new MeetingSessionLifecycle();
  const releaseStop = deferred();
  let stopCount = 0;

  await lifecycle.start(() => undefined);
  const stopA = lifecycle.stop(async () => {
    stopCount += 1;
    await releaseStop.promise;
  });
  const prepare = lifecycle.run(() => undefined);
  const duplicateStopA = lifecycle.stop(() => {
    stopCount += 1;
  });

  assert.equal(duplicateStopA, stopA);
  releaseStop.resolve();
  await Promise.all([stopA, prepare, duplicateStopA]);
  assert.equal(stopCount, 1);
});
