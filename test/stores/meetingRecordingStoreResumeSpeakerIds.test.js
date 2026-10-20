const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// "Record more" seeds a recording with the note's earlier transcript. Speaker
// ids key the note's names, locks, mappings and embeddings, so the resumed
// session's speakers must never reuse an earlier session's id.

const NOTE_ID = 21;
const START_ARGS = {
  noteId: NOTE_ID,
  noteTitle: "Planning",
  folderId: null,
  autoEndEligible: true,
};

function createElectronAPI({ startResult = {} } = {}) {
  const noopListener = () => () => {};
  const state = { startOptions: [], segmentCallback: null };
  const api = {
    checkSystemAudioAccess: async () => ({
      granted: true,
      status: "granted",
      mode: "native",
      strategy: "native",
    }),
    meetingTranscriptionStart: async (options) => {
      state.startOptions.push(options);
      return {
        success: true,
        systemAudioMode: "native",
        systemAudioStrategy: "native",
        speakerIndexBase: options.speakerIndexBase,
        ...startResult,
      };
    },
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionStop: async () => ({ success: true, diarizationSessionId: null }),
    meetingTranscriptionSend: () => {},
    getNote: async () => null,
    updateNote: async () => ({ success: true }),
    onMeetingDiarizationComplete: noopListener,
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
  return { api, state };
}

async function loadStore(t, api) {
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-resume-speaker-ids-test-",
  });
  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

// Seeded rows end "just now", inside the 8 s carry-forward window, so a
// resumed row would inherit the last seeded speaker if nothing stopped it.
function earlierSession() {
  const now = Date.now();
  return [
    {
      id: "s0",
      text: "let's start",
      source: "system",
      timestamp: now - 2_000,
      speaker: "speaker_0",
      speakerName: "Ada",
      speakerLocked: true,
      speakerIsPlaceholder: false,
    },
    {
      id: "s1",
      text: "agreed",
      source: "system",
      timestamp: now - 1_000,
      speaker: "speaker_1",
      speakerIsPlaceholder: true,
    },
  ];
}

function emitSystemFinal(state, text) {
  state.segmentCallback({ text, source: "system", type: "final", timestamp: Date.now() });
}

const segmentsOf = (store) => store.useMeetingRecordingStore.getState().segments;
const segmentWithText = (store, text) => segmentsOf(store).find((s) => s.text === text);

test("a fresh meeting numbers its speakers from speaker_0", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(state.startOptions[0].speakerIndexBase, 0);

  emitSystemFinal(state, "hello");
  assert.equal(segmentWithText(store, "hello").speaker, "speaker_0");
  await store.stopRecording();
});

test("a resumed recording gives its speakers ids past the earlier session's", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: earlierSession() }), true);
  assert.equal(state.startOptions[0].speakerIndexBase, 2);

  emitSystemFinal(state, "picking back up");
  const resumed = segmentWithText(store, "picking back up");
  // Two expected speakers cap placeholders at one other voice; that cap counts
  // this session's speakers, so it must not clamp back to speaker_0.
  assert.equal(resumed.speaker, "speaker_2");
  assert.notEqual(resumed.speakerName, "Ada");
  assert.notEqual(resumed.speakerLocked, true);

  const seeded = segmentWithText(store, "let's start");
  assert.equal(seeded.speaker, "speaker_0");
  assert.equal(seeded.speakerName, "Ada");
  await store.stopRecording();
});

test("main can raise the base past ids only the note's stored mappings use", async (t) => {
  const { api, state } = createElectronAPI({ startResult: { speakerIndexBase: 5 } });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: earlierSession() }), true);
  emitSystemFinal(state, "new voice");
  assert.equal(segmentWithText(store, "new voice").speaker, "speaker_5");
  await store.stopRecording();
});

test("a lower base from main never pulls the session back onto earlier ids", async (t) => {
  const { api, state } = createElectronAPI({ startResult: { speakerIndexBase: 0 } });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: earlierSession() }), true);
  emitSystemFinal(state, "new voice");
  assert.equal(segmentWithText(store, "new voice").speaker, "speaker_2");
  await store.stopRecording();
});

test("a 1:1 attendee is bound to the resumed session's first speaker id", async (t) => {
  const { api, state } = createElectronAPI({
    startResult: { oneOnOneAttendee: { displayName: "Grace", email: null } },
  });
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: earlierSession() }), true);
  emitSystemFinal(state, "hi again");
  const resumed = segmentWithText(store, "hi again");
  assert.equal(resumed.speaker, "speaker_2");
  assert.equal(resumed.speakerName, "Grace");
  assert.equal(segmentWithText(store, "agreed").speakerName, undefined);
  await store.stopRecording();
});

test("resuming twice keeps every session's speaker ids distinct", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: earlierSession() }), true);
  emitSystemFinal(state, "second session");
  await store.stopRecording();
  const afterSecond = segmentsOf(store);
  assert.equal(segmentWithText(store, "second session").speaker, "speaker_2");

  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: afterSecond }), true);
  assert.equal(state.startOptions[1].speakerIndexBase, 3);
  emitSystemFinal(state, "third session");
  assert.equal(segmentWithText(store, "third session").speaker, "speaker_3");
  assert.equal(segmentWithText(store, "second session").speaker, "speaker_2");
  await store.stopRecording();
});

test("renaming a speaker during a resumed recording touches only that session's rows", async (t) => {
  const { api, state } = createElectronAPI();
  const store = await loadStore(t, api);

  assert.equal(await store.startRecording({ ...START_ARGS, seedSegments: earlierSession() }), true);
  emitSystemFinal(state, "new voice");
  const newSpeaker = segmentWithText(store, "new voice").speaker;

  store.lockSpeaker(newSpeaker, "Bob");
  assert.equal(segmentWithText(store, "new voice").speakerName, "Bob");
  assert.equal(segmentWithText(store, "let's start").speakerName, "Ada");
  assert.equal(segmentWithText(store, "agreed").speakerName, undefined);
  assert.notEqual(segmentWithText(store, "agreed").speakerLocked, true);

  // Renaming an earlier session's speaker leaves the new voice alone.
  store.lockSpeaker("speaker_1", "Carol");
  assert.equal(segmentWithText(store, "agreed").speakerName, "Carol");
  assert.equal(segmentWithText(store, "new voice").speakerName, "Bob");

  // Later rows from the renamed voice keep its lock.
  emitSystemFinal(state, "still me");
  assert.equal(segmentWithText(store, "still me").speaker, newSpeaker);
  assert.equal(segmentWithText(store, "still me").speakerName, "Bob");
  await store.stopRecording();
});
