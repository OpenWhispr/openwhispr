const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/meetingRecordingSession.ts");

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("creates one opaque session ID for a recording start", async () => {
  const { createMeetingRecordingSessionId } = await load();
  let calls = 0;

  const sessionId = createMeetingRecordingSessionId(() => {
    calls += 1;
    return "recording-session-1";
  });

  assert.equal(sessionId, "recording-session-1");
  assert.equal(calls, 1);
});

test("accepts legacy stops but rejects an expected ID for another active session", async () => {
  const { canStopMeetingRecordingSession } = await load();

  assert.equal(canStopMeetingRecordingSession("meeting-2"), true);
  assert.equal(canStopMeetingRecordingSession("meeting-2", "meeting-2"), true);
  assert.equal(canStopMeetingRecordingSession("meeting-2", "meeting-1"), false);
  assert.equal(canStopMeetingRecordingSession(null, "meeting-1"), false);
});

test("auto-end stop requests acknowledge only a completed scoped stop", async () => {
  const { requestMeetingRecordingAutoEnd } = await load();
  const requestedSessions = [];
  const completedSessions = [];
  const errors = [];
  const stopRecording = async (sessionId) => {
    requestedSessions.push(sessionId);
    return { stopped: sessionId === "meeting-2" };
  };
  const onStopped = (sessionId, stopped) => completedSessions.push({ sessionId, stopped });
  const onError = (error, sessionId) => errors.push({ error, sessionId });

  assert.equal(
    requestMeetingRecordingAutoEnd(
      { sessionId: "meeting-2" },
      stopRecording,
      onStopped,
      onError
    ),
    true
  );
  assert.equal(
    requestMeetingRecordingAutoEnd({ sessionId: "meeting-1" }, stopRecording, onStopped, onError),
    true
  );
  assert.equal(
    requestMeetingRecordingAutoEnd({ sessionId: "" }, stopRecording, onStopped, onError),
    false
  );
  assert.equal(requestMeetingRecordingAutoEnd(null, stopRecording, onStopped, onError), false);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(requestedSessions, ["meeting-2", "meeting-1"]);
  // Both settle: the caller must learn about a stop that completed without a
  // persisted result, or an auto-end ends the recording with no feedback.
  assert.deepEqual(completedSessions, [
    { sessionId: "meeting-2", stopped: true },
    { sessionId: "meeting-1", stopped: false },
  ]);
  assert.deepEqual(errors, []);
});

test("a rejected auto-end stop is reported instead of swallowed", async () => {
  const { requestMeetingRecordingAutoEnd } = await load();
  const errors = [];
  const stopFailure = new Error("stop failed");
  const stopRecording = async () => {
    throw stopFailure;
  };

  assert.equal(
    requestMeetingRecordingAutoEnd(
      { sessionId: "meeting-2" },
      stopRecording,
      () => undefined,
      (error, sessionId) => errors.push({ error, sessionId })
    ),
    true
  );
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(errors, [{ error: stopFailure, sessionId: "meeting-2" }]);
});

test("restart context preserves note identity and session speaker settings", async () => {
  const { createMeetingAutoEndRestartContext } = await load();
  const seedSegments = [{ id: "segment-1", text: "Hello", source: "mic" }];

  assert.deepEqual(
    createMeetingAutoEndRestartContext("meeting-2", "meeting-2", {
      recordingNoteId: 42,
      recordingNoteTitle: "Planning",
      recordingFolderId: 8,
      sessionDiarizationEnabled: false,
      sessionExpectedCount: 5,
      userTouchedStepper: true,
      segments: seedSegments,
    }),
    {
      sessionId: "meeting-2",
      args: {
        noteId: 42,
        noteTitle: "Planning",
        folderId: 8,
        seedSegments,
        diarizationEnabled: false,
        expectedCount: 5,
        expectedCountIsExplicit: true,
        autoEndEligible: true,
      },
    }
  );
  assert.equal(
    createMeetingAutoEndRestartContext("meeting-1", "meeting-2", {
      recordingNoteId: 42,
      recordingNoteTitle: "Planning",
      recordingFolderId: 8,
      sessionDiarizationEnabled: true,
      sessionExpectedCount: 2,
      userTouchedStepper: false,
      segments: [],
    }),
    null
  );
});

test("only meeting notes are eligible for automatic ending", async () => {
  const { isMeetingAutoEndEligible } = await load();

  assert.equal(isMeetingAutoEndEligible({ note_type: "meeting" }), true);
  assert.equal(isMeetingAutoEndEligible({ note_type: "personal" }), false);
  assert.equal(isMeetingAutoEndEligible({ note_type: "upload" }), false);
  assert.equal(isMeetingAutoEndEligible(null), false);
});

test("a new renderer start waits for the accepted stop to finish", async () => {
  const { createMeetingRecordingStopBarrier } = await load();
  let finishStop;
  const stopDeferred = new Promise((resolve) => {
    finishStop = resolve;
  });
  const barrier = createMeetingRecordingStopBarrier();
  let nextStartBegan = false;

  const stopPromise = barrier.runStop(() => stopDeferred);
  const nextStartPromise = barrier.waitForPendingStop().then(() => {
    nextStartBegan = true;
  });
  await Promise.resolve();

  assert.equal(nextStartBegan, false);

  finishStop("stopped");
  assert.equal(await stopPromise, "stopped");
  await nextStartPromise;
  assert.equal(nextStartBegan, true);
});

test("renderer setup failure teardown blocks retry and deduplicates concurrent stop cleanup", async () => {
  const { createMeetingRecordingStopBarrier, teardownFailedMeetingRecordingSetup } = await load();
  let finishMainStop;
  const mainStopDeferred = new Promise((resolve) => {
    finishMainStop = resolve;
  });
  let markMainStopBegan;
  const mainStopBegan = new Promise((resolve) => {
    markMainStopBegan = resolve;
  });
  const barrier = createMeetingRecordingStopBarrier();
  const events = [];
  let activeSessionId = "meeting-1";
  let retryCaptureCount = 0;

  const setupFailurePromise = teardownFailedMeetingRecordingSetup({
    stopBarrier: barrier,
    cleanup: async () => {
      events.push("cleanup");
    },
    stopMain: async () => {
      events.push("main-stop");
      markMainStopBegan();
      await mainStopDeferred;
    },
    releaseSession: () => {
      activeSessionId = null;
      events.push("release-session");
    },
  });
  const retryPromise = barrier.waitForPendingStop().then(() => {
    assert.equal(activeSessionId, null);
    retryCaptureCount += 1;
    events.push("retry-capture");
  });
  const concurrentStopPromise = barrier.runStop(async () => {
    events.push("duplicate-cleanup");
  });
  await mainStopBegan;

  assert.deepEqual(events, ["cleanup", "main-stop"]);
  assert.equal(retryCaptureCount, 0);

  finishMainStop();
  await Promise.all([setupFailurePromise, retryPromise, concurrentStopPromise]);

  assert.deepEqual(events, ["cleanup", "main-stop", "release-session", "retry-capture"]);
  assert.equal(retryCaptureCount, 1);
});

test("same-turn stop cancels an admitted start before its first continuation", async () => {
  const { createMeetingRecordingStartCoordinator } = await load();
  const coordinator = createMeetingRecordingStartCoordinator();
  const events = [];

  const firstStart = coordinator.runStart("meeting-1", async (operation) => {
    events.push(operation.isCurrent() ? "capture:meeting-1" : "canceled:meeting-1");
  });
  const canceledStart = coordinator.cancelActiveStart("meeting-1");
  const replacementStart = coordinator.runStart("meeting-2", async () => {
    events.push("capture:meeting-2");
  });

  assert.notEqual(canceledStart, null);
  await Promise.all([firstStart, canceledStart, replacementStart]);

  assert.deepEqual(events, ["canceled:meeting-1", "capture:meeting-2"]);
});

test("a committed renderer start is no longer cancelable", async () => {
  const { createMeetingRecordingStartCoordinator } = await load();
  const committed = createDeferred();
  const finishStart = createDeferred();
  const coordinator = createMeetingRecordingStartCoordinator();

  const startPromise = coordinator.runStart("meeting-1", async (operation) => {
    operation.markCommitted();
    committed.resolve();
    await finishStart.promise;
  });
  await committed.promise;

  assert.equal(coordinator.cancelActiveStart("meeting-1"), null);

  finishStart.resolve();
  await startPromise;
});

test("stop during deferred preparation cancels the old start before admitting replacement", async () => {
  const { createMeetingRecordingStartCoordinator } = await load();
  const preparation = createDeferred();
  const firstStartBegan = createDeferred();
  const coordinator = createMeetingRecordingStartCoordinator();
  const events = [];

  const firstStart = coordinator.runStart("meeting-1", async (operation) => {
    events.push("prepare:meeting-1");
    firstStartBegan.resolve();
    await preparation.promise;
    events.push(operation.isCurrent() ? "capture:meeting-1" : "canceled:meeting-1");
  });
  await firstStartBegan.promise;
  const canceledStart = coordinator.cancelActiveStart("meeting-1");
  const replacementStart = coordinator.runStart("meeting-2", async () => {
    events.push("capture:meeting-2");
  });
  await Promise.resolve();

  assert.deepEqual(events, ["prepare:meeting-1"]);

  preparation.resolve();
  await Promise.all([firstStart, canceledStart, replacementStart]);

  assert.deepEqual(events, ["prepare:meeting-1", "canceled:meeting-1", "capture:meeting-2"]);
});

test("system-audio rejection settles a canceled start before replacement", async () => {
  const { createMeetingRecordingStartCoordinator } = await load();
  const systemAudio = createDeferred();
  const systemAudioBegan = createDeferred();
  const coordinator = createMeetingRecordingStartCoordinator();
  const events = [];

  const firstStart = coordinator.runStart("meeting-1", async () => {
    events.push("system-audio:meeting-1");
    systemAudioBegan.resolve();
    await systemAudio.promise;
  });
  const firstStartRejection = assert.rejects(firstStart, /system audio denied/);
  await systemAudioBegan.promise;
  const canceledStart = coordinator.cancelActiveStart("meeting-1");
  const replacementStart = coordinator.runStart("meeting-2", async () => {
    events.push("capture:meeting-2");
  });

  systemAudio.reject(new Error("system audio denied"));
  await Promise.all([firstStartRejection, canceledStart, replacementStart]);

  assert.deepEqual(events, ["system-audio:meeting-1", "capture:meeting-2"]);
});

test("cancellation after deferred main start stops the old session once before replacement", async () => {
  const { createMeetingRecordingStartCoordinator } = await load();
  const mainStart = createDeferred();
  const mainStartBegan = createDeferred();
  const coordinator = createMeetingRecordingStartCoordinator();
  const events = [];
  let scopedStopCount = 0;

  const firstStart = coordinator.runStart("meeting-1", async (operation) => {
    operation.markMainStartAttempted();
    events.push("main-start:meeting-1");
    mainStartBegan.resolve();
    await mainStart.promise;
    if (!operation.isCurrent()) {
      const stopMain = async () => {
        scopedStopCount += 1;
        events.push("main-stop:meeting-1");
      };
      await Promise.all([operation.stopMainOnce(stopMain), operation.stopMainOnce(stopMain)]);
      events.push("canceled:meeting-1");
    }
  });
  await mainStartBegan.promise;
  const canceledStart = coordinator.cancelActiveStart("meeting-1");
  const replacementStart = coordinator.runStart("meeting-2", async () => {
    events.push("capture:meeting-2");
  });
  await Promise.resolve();

  assert.deepEqual(events, ["main-start:meeting-1"]);

  mainStart.resolve({ success: true });
  await Promise.all([firstStart, canceledStart, replacementStart]);

  assert.equal(scopedStopCount, 1);
  assert.deepEqual(events, [
    "main-start:meeting-1",
    "main-stop:meeting-1",
    "canceled:meeting-1",
    "capture:meeting-2",
  ]);
});

test("main-start rejection releases cancellation and replacement after one scoped stop", async () => {
  const { createMeetingRecordingStartCoordinator } = await load();
  const mainStart = createDeferred();
  const mainStartBegan = createDeferred();
  const coordinator = createMeetingRecordingStartCoordinator();
  const events = [];
  let scopedStopCount = 0;

  const firstStart = coordinator.runStart("meeting-1", async (operation) => {
    operation.markMainStartAttempted();
    events.push("main-start:meeting-1");
    mainStartBegan.resolve();
    try {
      await mainStart.promise;
    } catch (error) {
      await operation.stopMainOnce(async () => {
        scopedStopCount += 1;
        events.push("main-stop:meeting-1");
      });
      throw error;
    }
  });
  const firstStartRejection = assert.rejects(firstStart, /main start failed/);
  await mainStartBegan.promise;
  const canceledStart = coordinator.cancelActiveStart("meeting-1");
  const replacementStart = coordinator.runStart("meeting-2", async () => {
    events.push("capture:meeting-2");
  });

  mainStart.reject(new Error("main start failed"));
  await Promise.all([firstStartRejection, canceledStart, replacementStart]);

  assert.equal(scopedStopCount, 1);
  assert.deepEqual(events, ["main-start:meeting-1", "main-stop:meeting-1", "capture:meeting-2"]);
});

const parseSegments = (raw) => JSON.parse(raw);

test("restart seeds from the note's persisted transcript, not the stale live segments", async () => {
  const { resolveMeetingAutoEndRestartSeed } = await load();
  const diarized = [{ id: "a", text: "hello", speaker: "Ada" }];
  const stale = [{ id: "a", text: "hello", speaker: null }];

  const result = resolveMeetingAutoEndRestartSeed(
    7,
    { transcript: JSON.stringify(diarized), deleted_at: null },
    parseSegments,
    stale
  );

  assert.deepEqual(result, { ok: true, seedSegments: diarized });
});

test("restart refuses a note that was deleted during the restart window", async () => {
  const { resolveMeetingAutoEndRestartSeed } = await load();

  assert.deepEqual(
    resolveMeetingAutoEndRestartSeed(
      7,
      { transcript: "[]", deleted_at: "2026-08-27T00:00:00Z" },
      parseSegments,
      []
    ),
    { ok: false, reason: "note-missing" }
  );
});

test("restart refuses a note that no longer exists", async () => {
  const { resolveMeetingAutoEndRestartSeed } = await load();

  assert.deepEqual(resolveMeetingAutoEndRestartSeed(7, null, parseSegments, []), {
    ok: false,
    reason: "note-missing",
  });
});

test("restart without a note keeps the live segments it captured", async () => {
  const { resolveMeetingAutoEndRestartSeed } = await load();
  const live = [{ id: "a", text: "hello" }];

  assert.deepEqual(resolveMeetingAutoEndRestartSeed(null, null, parseSegments, live), {
    ok: true,
    seedSegments: live,
  });
});

test("restart starts empty when the note has no transcript yet", async () => {
  const { resolveMeetingAutoEndRestartSeed } = await load();

  assert.deepEqual(
    resolveMeetingAutoEndRestartSeed(7, { transcript: "", deleted_at: null }, parseSegments, [
      { id: "a", text: "stale" },
    ]),
    { ok: true, seedSegments: [] }
  );
});

// runMeetingAutoEndRestart owns every abort path, so the component can toast on
// all of them instead of dropping some silently.
function createRestartDeps(overrides = {}) {
  const started = [];
  return {
    started,
    deps: {
      getActiveSessionId: () => null,
      getLatestSegments: () => [],
      getNote: async () => ({ transcript: "[]", deleted_at: null }),
      parseSegments,
      startRecording: async (args) => {
        started.push(args);
        return true;
      },
      ...overrides,
    },
  };
}

const restartContext = (sessionId = "meeting-1", args = {}) => ({
  sessionId,
  args: { noteId: 7, noteTitle: "Standup", folderId: 3, seedSegments: [], ...args },
});

test("a delivered restart starts a recording seeded from the note", async () => {
  const { runMeetingAutoEndRestart } = await load();
  const { deps, started } = createRestartDeps({
    getNote: async () => ({
      transcript: JSON.stringify([{ id: "a", text: "hi" }]),
      deleted_at: null,
    }),
  });

  const outcome = await runMeetingAutoEndRestart(
    { sessionId: "meeting-1" },
    restartContext(),
    deps
  );

  assert.deepEqual(outcome, { status: "started" });
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].seedSegments, [{ id: "a", text: "hi" }]);
  assert.equal(started[0].noteId, 7);
});

test("a restart whose context died reports an abort instead of failing silently", async () => {
  const { runMeetingAutoEndRestart } = await load();
  const { deps, started } = createRestartDeps();

  assert.deepEqual(await runMeetingAutoEndRestart({ sessionId: "meeting-1" }, null, deps), {
    status: "aborted",
    reason: "no-context",
  });
  assert.deepEqual(
    await runMeetingAutoEndRestart({ sessionId: "meeting-9" }, restartContext(), deps),
    { status: "aborted", reason: "no-context" }
  );
  assert.equal(started.length, 0);
});

test("a restart racing an already-live recording aborts before it starts one", async () => {
  const { runMeetingAutoEndRestart } = await load();
  const { deps, started } = createRestartDeps({ getActiveSessionId: () => "meeting-other" });

  assert.deepEqual(
    await runMeetingAutoEndRestart({ sessionId: "meeting-1" }, restartContext(), deps),
    { status: "aborted", reason: "already-recording" }
  );
  assert.equal(started.length, 0);
});

// The note read is awaited, so a manual recording can win the race after the
// first guard passed. Starting anyway would adopt the old note under the user's
// new recording.
test("a recording that starts while the note is being read cancels the restart", async () => {
  const { runMeetingAutoEndRestart } = await load();
  let activeSessionId = null;
  const noteRead = createDeferred();
  const { deps, started } = createRestartDeps({
    getActiveSessionId: () => activeSessionId,
    getNote: () => noteRead.promise,
  });

  const outcome = runMeetingAutoEndRestart({ sessionId: "meeting-1" }, restartContext(), deps);
  activeSessionId = "meeting-manual";
  noteRead.resolve({ transcript: "[]", deleted_at: null });

  assert.deepEqual(await outcome, { status: "aborted", reason: "already-recording" });
  assert.equal(started.length, 0);
});

test("a restart whose note vanished aborts without starting a recording", async () => {
  const { runMeetingAutoEndRestart } = await load();
  const { deps, started } = createRestartDeps({ getNote: async () => null });

  assert.deepEqual(
    await runMeetingAutoEndRestart({ sessionId: "meeting-1" }, restartContext(), deps),
    { status: "aborted", reason: "note-missing" }
  );
  assert.equal(started.length, 0);
});

test("a restart that startRecording refuses reports an abort", async () => {
  const { runMeetingAutoEndRestart } = await load();
  const { deps } = createRestartDeps({ startRecording: async () => false });

  assert.deepEqual(
    await runMeetingAutoEndRestart({ sessionId: "meeting-1" }, restartContext(), deps),
    { status: "aborted", reason: "start-refused" }
  );
});

test("a restart without a note keeps the segments captured at the stop", async () => {
  const { runMeetingAutoEndRestart } = await load();
  const live = [{ id: "a", text: "in person" }];
  const { deps, started } = createRestartDeps({ getLatestSegments: () => live });

  const outcome = await runMeetingAutoEndRestart(
    { sessionId: "meeting-1" },
    restartContext("meeting-1", { noteId: null }),
    deps
  );

  assert.deepEqual(outcome, { status: "started" });
  assert.deepEqual(started[0].seedSegments, live);
});
