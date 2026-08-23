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
    abort: async () => {
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

test("owner loss during deferred startup invalidates immediately and never enters graceful stop", async () => {
  const startDeferred = createDeferred();
  const ownerWebContents = createOwnerWebContents();
  const events = [];
  const lifecycle = createMeetingTranscriptionLifecycle({
    start: async ({ sessionId }) => {
      events.push(`start:${sessionId}`);
      await startDeferred.promise;
      return { success: true, sessionId };
    },
    stop: async (sessionId) => {
      events.push(`stop:${sessionId}`);
      return { success: true };
    },
    abort: async (sessionId) => {
      events.push(`abort:${sessionId}`);
      return { success: true };
    },
    onAbortRequested: (sessionId) => events.push(`invalidate:${sessionId}`),
  });

  const starting = lifecycle.startSession({
    sessionId: "meeting-crash",
    ownerWebContents,
    options: {},
  });
  await Promise.resolve();
  ownerWebContents.emit("render-process-gone", {}, { reason: "crashed" });

  assert.deepEqual(events, ["start:meeting-crash", "invalidate:meeting-crash"]);
  startDeferred.resolve();
  await starting;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    "start:meeting-crash",
    "invalidate:meeting-crash",
    "abort:meeting-crash",
  ]);
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
      abort: async () => {
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

test("a replacement is still rejected while the current session is active", async () => {
  const starts = [];
  const lifecycle = createMeetingTranscriptionLifecycle({
    start: async ({ sessionId }) => {
      starts.push(sessionId);
      return { success: true, sessionId };
    },
    stop: async () => ({ success: true }),
  });

  await lifecycle.startSession({
    sessionId: "meeting-1",
    ownerWebContents: createOwnerWebContents(),
    options: {},
  });
  assert.deepEqual(
    await lifecycle.startSession({
      sessionId: "meeting-2",
      ownerWebContents: createOwnerWebContents(),
      options: {},
    }),
    { success: false, error: "Operation in progress" }
  );
  assert.deepEqual(starts, ["meeting-1"]);
});

test("renderer operations require the exact session id and owning web contents", async () => {
  const ownerWebContents = createOwnerWebContents();
  const otherWebContents = createOwnerWebContents();
  const lifecycle = createMeetingTranscriptionLifecycle({
    start: async ({ sessionId }) => ({ success: true, sessionId }),
    stop: async () => ({ success: true }),
  });

  await lifecycle.startSession({
    sessionId: "meeting-owned",
    ownerWebContents,
    options: {},
  });

  assert.equal(lifecycle.isOwnedSession("meeting-owned", ownerWebContents), true);
  assert.equal(lifecycle.isOwnedSession(undefined, ownerWebContents), false);
  assert.equal(lifecycle.isOwnedSession("meeting-other", ownerWebContents), false);
  assert.equal(lifecycle.isOwnedSession("meeting-owned", otherWebContents), false);
});

test("authorization abort during startup never uses the graceful stop path", async () => {
  const startDeferred = createDeferred();
  const events = [];
  const lifecycle = createMeetingTranscriptionLifecycle({
    start: async ({ sessionId }) => {
      events.push(`start:${sessionId}`);
      await startDeferred.promise;
      return { success: true, sessionId };
    },
    stop: async (sessionId) => {
      events.push(`stop:${sessionId}`);
      return { success: true };
    },
    abort: async (sessionId) => {
      events.push(`abort:${sessionId}`);
      return { success: true };
    },
  });

  const start = lifecycle.startSession({
    sessionId: "meeting-1",
    ownerWebContents: createOwnerWebContents(),
    options: {},
  });
  await Promise.resolve();
  const abort = lifecycle.abortSession("meeting-1");
  startDeferred.resolve();

  await Promise.all([start, abort]);
  assert.deepEqual(events, ["start:meeting-1", "abort:meeting-1"]);
});

test("authorization abort of an active session never finalizes through stop", async () => {
  const events = [];
  const lifecycle = createMeetingTranscriptionLifecycle({
    start: async ({ sessionId }) => ({ success: true, sessionId }),
    stop: async (sessionId) => {
      events.push(`stop:${sessionId}`);
      return { success: true };
    },
    abort: async (sessionId) => {
      events.push(`abort:${sessionId}`);
      return { success: true };
    },
  });
  await lifecycle.startSession({
    sessionId: "meeting-1",
    ownerWebContents: createOwnerWebContents(),
    options: {},
  });

  await lifecycle.abortSession("meeting-1");
  assert.deepEqual(events, ["abort:meeting-1"]);
});

test("authorization abort immediately overtakes an accepted graceful stop", async () => {
  const stopStarted = createDeferred();
  const stopCompletion = createDeferred();
  const events = [];
  let abortVisibleToStop = false;
  const lifecycle = createMeetingTranscriptionLifecycle({
    start: async ({ sessionId }) => ({ success: true, sessionId }),
    stop: async (sessionId, abortSignal) => {
      events.push(`stop:${sessionId}`);
      stopStarted.resolve();
      await stopCompletion.promise;
      abortVisibleToStop = abortSignal.aborted;
      return { success: true, transcript: "stale transcript" };
    },
    abort: async (sessionId) => {
      events.push(`abort:${sessionId}`);
      return { success: true };
    },
    onAbortRequested: (sessionId) => {
      events.push(`invalidate:${sessionId}`);
    },
  });
  await lifecycle.startSession({
    sessionId: "meeting-1",
    ownerWebContents: createOwnerWebContents(),
    options: {},
  });

  const stopping = lifecycle.stopSession("meeting-1");
  await stopStarted.promise;
  const aborting = lifecycle.abortSession("meeting-1");
  await Promise.resolve();

  assert.deepEqual(events, ["stop:meeting-1", "invalidate:meeting-1", "abort:meeting-1"]);

  stopCompletion.resolve();
  assert.deepEqual(await stopping, {
    success: false,
    reason: "authorization-changed",
    code: "AUTHORIZATION_BOUNDARY_CHANGED",
  });
  assert.deepEqual(await aborting, { success: true });
  assert.equal(abortVisibleToStop, true);
});

test("renderer crash overtakes a deferred graceful flush and never returns its result", async () => {
  const ownerWebContents = createOwnerWebContents();
  const flushStarted = createDeferred();
  const flushCompletion = createDeferred();
  const events = [];
  const lifecycle = createMeetingTranscriptionLifecycle({
    start: async ({ sessionId }) => ({ success: true, sessionId }),
    stop: async (sessionId, abortSignal) => {
      events.push(`flush:${sessionId}`);
      flushStarted.resolve();
      await flushCompletion.promise;
      return { success: true, transcript: abortSignal.aborted ? "revoked" : "committed" };
    },
    abort: async (sessionId) => {
      events.push(`abort:${sessionId}`);
      return { success: true };
    },
  });
  await lifecycle.startSession({
    sessionId: "meeting-crash-flush",
    ownerWebContents,
    options: {},
  });

  const stopping = lifecycle.stopSession("meeting-crash-flush");
  await flushStarted.promise;
  ownerWebContents.emit("render-process-gone", {}, { reason: "crashed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["flush:meeting-crash-flush", "abort:meeting-crash-flush"]);

  flushCompletion.resolve();
  assert.deepEqual(await stopping, {
    success: false,
    reason: "authorization-changed",
    code: "AUTHORIZATION_BOUNDARY_CHANGED",
  });
});

test("a replacement waits for both an overtaken stop and its authorization abort", async () => {
  const stopCompletion = createDeferred();
  const abortCompletion = createDeferred();
  const events = [];
  const currentBindings = new Set(["binding-a", "binding-b"]);
  let activeCaptureSessionId = null;
  const lifecycle = createMeetingTranscriptionLifecycle({
    start: async ({ sessionId }) => {
      events.push(`start:${sessionId}`);
      activeCaptureSessionId = sessionId;
      return { success: true, sessionId };
    },
    stop: async (sessionId) => {
      events.push(`stop:${sessionId}`);
      await stopCompletion.promise;
      if (activeCaptureSessionId === sessionId) activeCaptureSessionId = null;
      return { success: true };
    },
    abort: async (sessionId) => {
      events.push(`abort:${sessionId}`);
      await abortCompletion.promise;
      if (activeCaptureSessionId === sessionId) activeCaptureSessionId = null;
      return { success: true };
    },
    isStartAuthorized: (authorizationBinding) => currentBindings.has(authorizationBinding),
  });

  await lifecycle.startSession({
    sessionId: "meeting-1",
    ownerWebContents: createOwnerWebContents(),
    options: {},
    authorizationBinding: "binding-a",
  });
  const stopping = lifecycle.stopSession("meeting-1");
  await Promise.resolve();
  const aborting = lifecycle.abortSession("meeting-1");
  await Promise.resolve();
  const replacement = lifecycle.startSession({
    sessionId: "meeting-2",
    ownerWebContents: createOwnerWebContents(),
    options: {},
    authorizationBinding: "binding-b",
  });
  await Promise.resolve();

  assert.deepEqual(events, ["start:meeting-1", "stop:meeting-1", "abort:meeting-1"]);
  assert.equal(activeCaptureSessionId, "meeting-1");

  stopCompletion.resolve();
  await stopping;
  await Promise.resolve();
  assert.deepEqual(events, ["start:meeting-1", "stop:meeting-1", "abort:meeting-1"]);

  abortCompletion.resolve();
  assert.deepEqual(await aborting, { success: true });
  assert.equal((await replacement).success, true);
  assert.deepEqual(events, [
    "start:meeting-1",
    "stop:meeting-1",
    "abort:meeting-1",
    "start:meeting-2",
  ]);
  assert.equal(activeCaptureSessionId, "meeting-2");
});

test("owner loss cancels a queued replacement before any capture can start", async () => {
  const stopCompletion = createDeferred();
  const replacementOwner = createOwnerWebContents();
  const starts = [];
  const lifecycle = createMeetingTranscriptionLifecycle({
    start: async ({ sessionId }) => {
      starts.push(sessionId);
      return { success: true, sessionId };
    },
    stop: async () => {
      await stopCompletion.promise;
      return { success: true };
    },
    abort: async () => ({ success: true }),
  });
  await lifecycle.startSession({
    sessionId: "meeting-active",
    ownerWebContents: createOwnerWebContents(),
    options: {},
  });
  const stopping = lifecycle.stopSession("meeting-active");
  await Promise.resolve();
  const replacement = lifecycle.startSession({
    sessionId: "meeting-queued-crash",
    ownerWebContents: replacementOwner,
    options: {},
  });
  replacementOwner.emit("destroyed");

  stopCompletion.resolve();
  await stopping;
  await replacement;
  assert.deepEqual(starts, ["meeting-active"]);
});

test("a second authorization change cancels a queued replacement for its exact binding", async () => {
  const stopCompletion = createDeferred();
  const abortCompletion = createDeferred();
  const events = [];
  const currentBindings = new Set(["binding-a", "binding-b"]);
  const lifecycle = createMeetingTranscriptionLifecycle({
    start: async ({ sessionId }) => {
      events.push(`start:${sessionId}`);
      return { success: true, sessionId };
    },
    stop: async (sessionId) => {
      events.push(`stop:${sessionId}`);
      await stopCompletion.promise;
      return { success: true };
    },
    abort: async (sessionId) => {
      events.push(`abort:${sessionId}`);
      await abortCompletion.promise;
      return { success: true };
    },
    isStartAuthorized: (authorizationBinding) => currentBindings.has(authorizationBinding),
    onAbortRequested: (sessionId) => events.push(`invalidate:${sessionId}`),
  });

  await lifecycle.startSession({
    sessionId: "meeting-1",
    ownerWebContents: createOwnerWebContents(),
    options: {},
    authorizationBinding: "binding-a",
  });
  const stopping = lifecycle.stopSession("meeting-1");
  await Promise.resolve();
  const aborting = lifecycle.abortSession("meeting-1");
  await Promise.resolve();
  const replacement = lifecycle.startSession({
    sessionId: "meeting-2",
    ownerWebContents: createOwnerWebContents(),
    options: {},
    authorizationBinding: "binding-b",
  });
  await Promise.resolve();

  currentBindings.delete("binding-b");
  assert.equal(
    lifecycle.cancelQueuedSessions((binding) => binding === "binding-b"),
    1
  );
  const repeatedAbort = lifecycle.abortSession();

  stopCompletion.resolve();
  abortCompletion.resolve();
  await Promise.all([stopping, aborting, repeatedAbort]);
  assert.deepEqual(await replacement, {
    success: false,
    reason: "authorization-changed",
    code: "AUTHORIZATION_BOUNDARY_CHANGED",
  });
  assert.deepEqual(events, [
    "start:meeting-1",
    "stop:meeting-1",
    "invalidate:meeting-1",
    "abort:meeting-1",
  ]);
});

test("a queued replacement revalidates its binding immediately before start", async () => {
  const stopCompletion = createDeferred();
  const starts = [];
  let bindingCurrent = true;
  const lifecycle = createMeetingTranscriptionLifecycle({
    start: async ({ sessionId }) => {
      starts.push(sessionId);
      return { success: true, sessionId };
    },
    stop: async () => {
      await stopCompletion.promise;
      return { success: true };
    },
    isStartAuthorized: () => bindingCurrent,
  });

  await lifecycle.startSession({
    sessionId: "meeting-1",
    ownerWebContents: createOwnerWebContents(),
    options: {},
    authorizationBinding: "binding-a",
  });
  const stopping = lifecycle.stopSession("meeting-1");
  await Promise.resolve();
  const replacement = lifecycle.startSession({
    sessionId: "meeting-2",
    ownerWebContents: createOwnerWebContents(),
    options: {},
    authorizationBinding: "binding-b",
  });

  bindingCurrent = false;
  stopCompletion.resolve();
  await stopping;
  assert.deepEqual(await replacement, {
    success: false,
    reason: "authorization-changed",
    code: "AUTHORIZATION_BOUNDARY_CHANGED",
  });
  assert.deepEqual(starts, ["meeting-1"]);
});
