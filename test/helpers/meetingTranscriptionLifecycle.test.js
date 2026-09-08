const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const createMeetingTranscriptionLifecycle = require("../../src/helpers/meetingTranscriptionLifecycle");

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createOwnerWebContents() {
  const ownerWebContents = new EventEmitter();
  ownerWebContents.isDestroyed = () => false;
  return ownerWebContents;
}

test("a stop requested during startup waits for startup and tears down that session", async () => {
  const startDeferred = createDeferred();
  const events = [];
  let captureActive = false;
  const lifecycle = createMeetingTranscriptionLifecycle({
    start: async ({ sessionId }) => {
      events.push(`start:${sessionId}:begin`);
      captureActive = true;
      await startDeferred.promise;
      events.push(`start:${sessionId}:end`);
      return { success: true, sessionId };
    },
    stop: async (sessionId) => {
      events.push(`stop:${sessionId}`);
      captureActive = false;
      return { success: true };
    },
  });

  const startPromise = lifecycle.startSession({
    sessionId: "meeting-1",
    ownerWebContents: createOwnerWebContents(),
    options: {},
  });
  await Promise.resolve();
  const stopPromise = lifecycle.stopSession("meeting-1");

  assert.equal(captureActive, true);
  assert.deepEqual(events, ["start:meeting-1:begin"]);

  startDeferred.resolve();
  assert.equal((await startPromise).success, true);
  assert.equal((await stopPromise).success, true);

  assert.equal(captureActive, false);
  assert.deepEqual(events, ["start:meeting-1:begin", "start:meeting-1:end", "stop:meeting-1"]);
});

test("owner loss during startup tears down after the deferred start settles", async () => {
  const startDeferred = createDeferred();
  const stopCompleted = createDeferred();
  const ownerWebContents = createOwnerWebContents();
  let captureActive = false;
  let countdownVisible = false;
  const lifecycle = createMeetingTranscriptionLifecycle({
    start: async ({ sessionId }) => {
      captureActive = true;
      countdownVisible = true;
      await startDeferred.promise;
      return { success: true, sessionId };
    },
    stop: async () => {
      captureActive = false;
      countdownVisible = false;
      stopCompleted.resolve();
      return { success: true };
    },
  });

  const startPromise = lifecycle.startSession({
    sessionId: "meeting-1",
    ownerWebContents,
    options: {},
  });
  await Promise.resolve();
  ownerWebContents.emit("destroyed");
  startDeferred.resolve();

  await startPromise;
  await stopCompleted.promise;
  await Promise.resolve();

  assert.equal(captureActive, false);
  assert.equal(countdownVisible, false);
  assert.equal(ownerWebContents.listenerCount("destroyed"), 0);
  assert.equal(ownerWebContents.listenerCount("render-process-gone"), 0);
});

for (const ownerLossEvent of ["destroyed", "render-process-gone"]) {
  test(`${ownerLossEvent} tears down an active session without renderer cooperation`, async () => {
    const stopCompleted = createDeferred();
    const ownerWebContents = createOwnerWebContents();
    let captureActive = false;
    let countdownVisible = false;
    const lifecycle = createMeetingTranscriptionLifecycle({
      start: async ({ sessionId }) => {
        captureActive = true;
        countdownVisible = true;
        return { success: true, sessionId };
      },
      stop: async () => {
        captureActive = false;
        countdownVisible = false;
        stopCompleted.resolve();
        return { success: true };
      },
    });

    await lifecycle.startSession({
      sessionId: "meeting-1",
      ownerWebContents,
      options: {},
    });
    ownerWebContents.emit(ownerLossEvent, {}, { reason: "crashed" });
    await stopCompleted.promise;
    await Promise.resolve();

    assert.equal(captureActive, false);
    assert.equal(countdownVisible, false);
    assert.equal(ownerWebContents.listenerCount("destroyed"), 0);
    assert.equal(ownerWebContents.listenerCount("render-process-gone"), 0);
  });
}

test("a replacement start waits for a deferred accepted stop to finish", async () => {
  const stopDeferred = createDeferred();
  const oldOwner = createOwnerWebContents();
  const newOwner = createOwnerWebContents();
  const starts = [];
  const stops = [];
  let activeCaptureSessionId = null;
  const lifecycle = createMeetingTranscriptionLifecycle({
    start: async ({ sessionId }) => {
      starts.push(sessionId);
      activeCaptureSessionId = sessionId;
      return { success: true, sessionId };
    },
    stop: async (sessionId) => {
      stops.push(sessionId);
      await stopDeferred.promise;
      activeCaptureSessionId = null;
      return { success: true };
    },
  });

  await lifecycle.startSession({
    sessionId: "meeting-1",
    ownerWebContents: oldOwner,
    options: {},
  });
  const stopPromise = lifecycle.stopSession("meeting-1");
  await Promise.resolve();
  const replacementPromise = lifecycle.startSession({
    sessionId: "meeting-2",
    ownerWebContents: newOwner,
    options: {},
  });
  await Promise.resolve();

  assert.deepEqual(starts, ["meeting-1"]);
  assert.deepEqual(stops, ["meeting-1"]);
  assert.equal(activeCaptureSessionId, "meeting-1");

  stopDeferred.resolve();
  await stopPromise;
  assert.equal((await replacementPromise).success, true);

  assert.deepEqual(starts, ["meeting-1", "meeting-2"]);
  assert.equal(activeCaptureSessionId, "meeting-2");
  assert.equal(oldOwner.listenerCount("destroyed"), 0);
  assert.equal(oldOwner.listenerCount("render-process-gone"), 0);
  assert.equal(newOwner.listenerCount("destroyed"), 1);
  assert.equal(newOwner.listenerCount("render-process-gone"), 1);

  oldOwner.emit("destroyed");
  await Promise.resolve();
  assert.deepEqual(stops, ["meeting-1"]);
  assert.equal(activeCaptureSessionId, "meeting-2");
});
