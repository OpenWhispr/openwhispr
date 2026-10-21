const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// Delayed diarization is always persisted to the note that owns its session.
// Publishing it to the UI is separate, and must not happen while a recording is
// still appending to that same note: the editor prefers a published overlay to
// the note's own text, so the live half would look like it had vanished.

const NOTE_ID = 11;
const START_ARGS = { noteId: NOTE_ID, noteTitle: "Standup", folderId: null, autoEndEligible: true };

function createElectronAPI({ stopDiarizationSessionId = null } = {}) {
  const noopListener = () => () => {};
  const state = {
    diarizationCallback: null,
    segmentCallback: null,
    updatedTranscripts: [],
    stopDiarizationSessionId,
    // Runs inside meetingTranscriptionStop, before its reply, like main's
    // synchronous skip-diarization send.
    onStop: null,
  };
  const notes = new Map([[NOTE_ID, { id: NOTE_ID, transcript: "", deleted_at: null }]]);
  const api = {
    checkSystemAudioAccess: async () => ({
      granted: true,
      status: "granted",
      mode: "native",
      strategy: "native",
    }),
    meetingTranscriptionStart: async () => ({
      success: true,
      systemAudioMode: "native",
      systemAudioStrategy: "native",
    }),
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionStop: async () => {
      state.onStop?.(state.stopDiarizationSessionId);
      return { success: true, diarizationSessionId: state.stopDiarizationSessionId };
    },
    meetingTranscriptionSend: () => {},
    getNote: async (id) => notes.get(id) ?? null,
    updateNote: async (id, patch) => {
      state.updatedTranscripts.push({ id, transcript: patch.transcript });
      const note = notes.get(id);
      if (note) note.transcript = patch.transcript;
      return { success: true };
    },
    saveNoteSpeakerEmbeddings: async () => ({ success: true }),
    onMeetingDiarizationComplete: (callback) => {
      state.diarizationCallback = callback;
      return () => {
        state.diarizationCallback = null;
      };
    },
    onMeetingTranscriptionSegment: (callback) => {
      state.segmentCallback = callback;
      return () => {
        state.segmentCallback = null;
      };
    },
    onMeetingSpeakerIdentified: noopListener,
    onMeetingSpeakersMerged: noopListener,
    onMeetingSessionSpeakerConfigUpdated: noopListener,
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
  };
  return { api, state, notes };
}

async function loadModules(t, api) {
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-diarization-publish-test-",
  });
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { parseTranscriptSegments } = await vite.ssrLoadModule("/utils/parseTranscriptSegments.ts");
  return { store, parseTranscriptSegments };
}

async function loadStore(t, api) {
  return (await loadModules(t, api)).store;
}

const ENRICHED = [{ id: "d0", text: "hello there", speaker: "speaker_0", speakerName: "Ada" }];

// The serial queue behind the listener awaits getNote and updateNote.
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

test("a finished session's diarization is not published over the recording that resumed its note", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);
  assert.equal(typeof state.diarizationCallback, "function");

  assert.equal(await store.startRecording(START_ARGS), true);
  state.updatedTranscripts.length = 0;

  state.diarizationCallback({
    noteId: NOTE_ID,
    sessionId: "diar-before-restart",
    segments: ENRICHED,
  });
  await settle();

  assert.equal(
    store.useMeetingRecordingStore.getState().completedDiarization,
    null,
    "the finished half must not paint over the live recording"
  );
  // Suppressing the overlay must not cost the enrichment its write.
  assert.equal(state.updatedTranscripts.length, 1);
  assert.match(state.updatedTranscripts[0].transcript, /Ada/);

  await store.stopRecording();
});

test("the same result publishes normally once the recording has stopped", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  await store.stopRecording();

  state.diarizationCallback({
    noteId: NOTE_ID,
    sessionId: "diar-after-stop",
    segments: ENRICHED,
  });
  await settle();

  const published = store.useMeetingRecordingStore.getState().completedDiarization;
  assert.equal(published?.noteId, NOTE_ID);
  assert.equal(published?.segments.length, 1);
});

test("a live recording on another note does not suppress the publish", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, noteId: 99 }), true);

  state.diarizationCallback({
    noteId: NOTE_ID,
    sessionId: "diar-other-note",
    segments: ENRICHED,
  });
  await settle();

  assert.equal(store.useMeetingRecordingStore.getState().completedDiarization?.noteId, NOTE_ID);
  await store.stopRecording();
});

// A resumed note seeds the recording with its earlier transcript, but the
// diarization result covers only the resumed session's audio. A repeated line
// must enrich the resumed session's row, never the earlier session's twin.
test("a resumed note's diarization labels the resumed session's row, not an earlier one with the same text", async (t) => {
  const { api, state } = createElectronAPI({ stopDiarizationSessionId: "diar-resumed" });
  const store = await loadStore(t, api);

  const earlierSession = [
    {
      id: "stored-0",
      text: "Can everyone hear me?",
      source: "system",
      timestamp: 1.0,
      speaker: "speaker_0",
      speakerName: "Bob",
      speakerIsPlaceholder: false,
      speakerStatus: "confirmed",
    },
    {
      id: "stored-1",
      text: "Yeah.",
      source: "system",
      timestamp: 4.2,
      speaker: "speaker_1",
      speakerName: "Carol",
      speakerIsPlaceholder: false,
      speakerStatus: "confirmed",
    },
  ];
  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: earlierSession }), true);
  state.segmentCallback({
    type: "final",
    source: "system",
    text: "Yeah.",
    timestamp: 1760000003000,
  });
  await store.stopRecording();

  state.diarizationCallback({
    noteId: NOTE_ID,
    sessionId: "diar-resumed",
    segments: [
      {
        text: "Yeah.",
        source: "system",
        timestamp: 3.0,
        speaker: "speaker_0",
        speakerName: "Dave",
        speakerIsPlaceholder: false,
        speakerStatus: "confirmed",
      },
    ],
  });
  await settle();

  const rows = JSON.parse(state.updatedTranscripts.at(-1).transcript);
  assert.deepEqual(
    rows.map((row) => [row.text, row.timestamp, row.speakerName]),
    [
      ["Can everyone hear me?", 1.0, "Bob"],
      ["Yeah.", 4.2, "Carol"],
      ["Yeah.", 3.0, "Dave"],
    ]
  );
});

const diarized = (text, timestamp, speakerName) => ({
  text,
  source: "system",
  timestamp,
  speaker: "speaker_0",
  speakerName,
  speakerIsPlaceholder: false,
  speakerStatus: "confirmed",
});

const rowsOf = (note) =>
  JSON.parse(note.transcript).map((row) => [row.text, row.timestamp, row.speakerName]);

// Each stop keeps its own seed length: with one shared value, the resumed
// session's seed would also shield the earlier session's own diarization.
test("an earlier session's diarization that lands after the note was resumed still labels its rows", async (t) => {
  const { api, state, notes } = createElectronAPI();
  const { store, parseTranscriptSegments } = await loadModules(t, api);
  const note = notes.get(NOTE_ID);

  state.stopDiarizationSessionId = "diar-1";
  assert.equal(await store.startRecording(START_ARGS), true);
  state.segmentCallback({
    type: "final",
    source: "system",
    text: "Yeah.",
    timestamp: 1760000001000,
  });
  await store.stopRecording();

  state.stopDiarizationSessionId = "diar-2";
  const seedSegments = parseTranscriptSegments(note.transcript);
  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments }), true);
  state.segmentCallback({
    type: "final",
    source: "system",
    text: "Yeah.",
    timestamp: 1760000100000,
  });
  await store.stopRecording();

  state.diarizationCallback({
    noteId: NOTE_ID,
    sessionId: "diar-1",
    segments: [diarized("Yeah.", 1.0, "Carol")],
  });
  await settle();
  state.diarizationCallback({
    noteId: NOTE_ID,
    sessionId: "diar-2",
    segments: [diarized("Yeah.", 2.0, "Dave")],
  });
  await settle();

  assert.deepEqual(rowsOf(note), [
    ["Yeah.", 1.0, "Carol"],
    ["Yeah.", 2.0, "Dave"],
  ]);
});

// An earlier session's result that removes rows after the note was resumed
// must not leave the resumed session's seed covering its own first row, even
// when it lands while the resumed session's stop call is still running.
for (const duringStop of [false, true]) {
  test(`rows an earlier session's diarization removes don't shift a resumed session's seed${duringStop ? " (mid-stop)" : ""}`, async (t) => {
    const { api, state, notes } = createElectronAPI();
    const { store, parseTranscriptSegments } = await loadModules(t, api);
    const note = notes.get(NOTE_ID);
    const echo = { text: "Yeah.", source: "mic", timestamp: 1760000001500 };

    state.stopDiarizationSessionId = "diar-1";
    assert.equal(await store.startRecording(START_ARGS), true);
    state.segmentCallback({
      type: "final",
      source: "system",
      text: "Yeah.",
      timestamp: 1760000001000,
    });
    state.segmentCallback({ type: "final", ...echo });
    await store.stopRecording();

    state.stopDiarizationSessionId = "diar-2";
    const seedSegments = parseTranscriptSegments(note.transcript);
    assert.equal(await store.startRecording({ ...START_ARGS, seedSegments }), true);
    state.segmentCallback({
      type: "final",
      source: "system",
      text: "Sure, go ahead.",
      timestamp: 1760000100000,
    });
    const earlierResult = async () => {
      state.diarizationCallback({
        noteId: NOTE_ID,
        sessionId: "diar-1",
        segments: [diarized("Yeah.", 1.0, "Carol")],
        removedSegments: [echo],
      });
      await settle();
    };
    if (duringStop) {
      const stop = api.meetingTranscriptionStop;
      api.meetingTranscriptionStop = async () => {
        await earlierResult();
        return stop();
      };
    }
    await store.stopRecording();
    if (!duringStop) await earlierResult();

    state.diarizationCallback({
      noteId: NOTE_ID,
      sessionId: "diar-2",
      segments: [diarized("Sure, go ahead.", 2.0, "Dave")],
    });
    await settle();

    assert.deepEqual(rowsOf(note), [
      ["Yeah.", 1.0, "Carol"],
      ["Sure, go ahead.", 2.0, "Dave"],
    ]);
  });
}

// Main sends a skipped diarization before the stop call returns, so the
// listener must read the seed length only after its getNote round trip.
test("a skipped diarization sent before stop returns still leaves the seeded rows alone", async (t) => {
  const { api, state, notes } = createElectronAPI({ stopDiarizationSessionId: "diar-skipped" });
  const { store, parseTranscriptSegments } = await loadModules(t, api);
  const note = notes.get(NOTE_ID);
  note.transcript = JSON.stringify([diarized("Yeah.", 1.0, "Carol")]);

  state.onStop = (sessionId) =>
    state.diarizationCallback({
      noteId: NOTE_ID,
      sessionId,
      segments: [{ id: "segment-0", text: "Yeah.", source: "system", timestamp: 1760000100001 }],
    });
  const seedSegments = parseTranscriptSegments(note.transcript);
  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments }), true);
  state.segmentCallback({
    type: "final",
    source: "system",
    text: "Yeah.",
    timestamp: 1760000100000,
  });
  await store.stopRecording();
  await settle();

  assert.deepEqual(rowsOf(note)[0], ["Yeah.", 1.0, "Carol"]);
});
