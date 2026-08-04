const test = require("node:test");
const assert = require("node:assert/strict");

const IPCHandlers = require("../../src/helpers/ipcHandlers");

// _startOrSkipDiarization has three exits — skipped, succeeded, failed — and every one
// of them must hand the note to the post-call pipeline. A failure that silently skips
// the enqueue leaves the note with no title, no meeting type and no notes.
//
// IPCHandlers cannot be constructed under node --test (its constructor calls
// setupHandlers(), and electron's ipcMain is undefined outside Electron), so these
// drive the real method on a prototype-only instance.
function createHandlers({ diarizeImpl, available = true } = {}) {
  const enqueued = [];
  const sent = [];

  const handlers = Object.create(IPCHandlers.prototype);
  Object.assign(handlers, {
    speakerDiarizationEnabled: true,
    diarizationManager: {
      isAvailable: () => available,
      convertRawPcmToWav: async () => "/tmp/ow-test-diar.wav",
      diarize: diarizeImpl || (async () => [{ speaker: "spk0", start: 0, end: 2 }]),
      capSpeakerClusters: (segments) => segments,
      mergeWithTranscript: (segments) => segments.map((s) => ({ ...s, speaker: "speaker_0" })),
    },
    databaseManager: {
      getSpeakerProfiles: () => [],
    },
    _resolveSpeakerExpectation: () => ({ numSpeakers: 0, cap: null }),
    _enqueuePostCallPipeline: (noteId) => enqueued.push(noteId),
  });

  const win = { isDestroyed: () => false, webContents: { send: (_c, p) => sent.push(p) } };

  return { handlers, enqueued, sent, win };
}

const SEGMENTS = [{ id: "s1", text: "hello", source: "system", timestamp: 0 }];

function run(handlers, win, noteId) {
  return handlers._startOrSkipDiarization(
    "session-1",
    "/tmp/ow-test-raw.pcm",
    0,
    SEGMENTS,
    win,
    null,
    null,
    noteId
  );
}

test("enqueues the pipeline when diarization throws", async () => {
  const { handlers, enqueued, sent, win } = createHandlers({
    diarizeImpl: async () => {
      throw new Error("diarization exploded");
    },
  });

  await run(handlers, win, 42);

  assert.deepEqual(enqueued, [42], "a diarization failure must still process the note");
  assert.deepEqual(
    sent.at(-1),
    { sessionId: "session-1", segments: [] },
    "renderer still needs the empty result to clear its diarizing state"
  );
});

test("does not enqueue on failure when there is no note", async () => {
  const { handlers, enqueued, win } = createHandlers({
    diarizeImpl: async () => {
      throw new Error("diarization exploded");
    },
  });

  await run(handlers, win, null);

  assert.deepEqual(enqueued, []);
});

test("enqueues exactly once on the success path", async () => {
  const { handlers, enqueued, win } = createHandlers();

  await run(handlers, win, 7);

  // A `finally`-based fix would pass the failure tests and double-run the whole
  // pipeline here — two large-model transcriptions over one note.
  assert.deepEqual(enqueued, [7]);
});

test("enqueues exactly once when diarization is unavailable", async () => {
  const { handlers, enqueued, win } = createHandlers({ available: false });

  await run(handlers, win, 9);

  assert.deepEqual(enqueued, [9]);
});
