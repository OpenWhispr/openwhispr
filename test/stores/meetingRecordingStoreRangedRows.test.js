const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// Local-model rows carry the range of their audio and arrive after the speaker
// identifications that covered it, so the live transcript labels them by overlap
// and lets a later identification that covers more of the row correct it.

const T = 1_800_000_000_000;
const START_ARGS = {
  noteId: 31,
  noteTitle: "Standup",
  folderId: null,
  autoEndEligible: true,
};

function createElectronAPI() {
  const noopListener = () => () => {};
  const state = { segmentCallback: null, speakerCallback: null };
  const api = {
    checkSystemAudioAccess: async () => ({
      granted: true,
      status: "granted",
      mode: "native",
      strategy: "native",
    }),
    meetingTranscriptionStart: async (options) => ({
      success: true,
      systemAudioMode: "native",
      systemAudioStrategy: "native",
      speakerIndexBase: options.speakerIndexBase,
    }),
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
    onMeetingSpeakerIdentified: (callback) => {
      state.speakerCallback = callback;
      return () => {
        state.speakerCallback = null;
      };
    },
    onMeetingSpeakersMerged: noopListener,
    onMeetingSessionSpeakerConfigUpdated: noopListener,
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
  };
  return { api, state };
}

async function startMeeting(t) {
  const { api, state } = createElectronAPI();
  let store = null;
  // Registered before the globals so the recording stops while `window` still exists.
  t.after(() => store?.stopRecording());
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-ranged-rows-test-",
  });
  store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  assert.equal(await store.startRecording(START_ARGS), true);
  return {
    store,
    identify: (identification) => state.speakerCallback(identification),
    final: (segment) => state.segmentCallback({ type: "final", ...segment }),
    rows: () => store.useMeetingRecordingStore.getState().segments,
  };
}

const A = (startTime, endTime, displayName) => ({
  speakerId: "speaker_0",
  displayName,
  startTime,
  endTime,
});
const B = (startTime, endTime, displayName) => ({
  speakerId: "speaker_1",
  displayName,
  startTime,
  endTime,
});

test("a ranged row takes the speaker heard for most of it", async (t) => {
  const { identify, final, rows } = await startMeeting(t);
  identify(A(T, T + 3000));
  identify(B(T + 3000, T + 9000));
  // The row starts inside A's window, so the point rule would give it to A.
  final({ text: "hello", source: "system", timestamp: T + 2500, endTimestamp: T + 8000 });
  assert.equal(rows()[0].speaker, "speaker_1");
  assert.equal(rows()[0].speakerStatus, "confirmed");
});

test("a later identification that covers more of a ranged row relabels it", async (t) => {
  const { identify, final, rows } = await startMeeting(t);
  identify(A(T, T + 1000));
  final({ text: "hello", source: "system", timestamp: T + 500, endTimestamp: T + 8000 });
  assert.equal(rows()[0].speaker, "speaker_0");
  identify(B(T + 1000, T + 8500));
  assert.equal(rows()[0].speaker, "speaker_1");
});

test("an identification covering less of a ranged row leaves it alone", async (t) => {
  const { identify, final, rows } = await startMeeting(t);
  identify(A(T, T + 6000));
  final({ text: "hello", source: "system", timestamp: T + 500, endTimestamp: T + 8000 });
  identify(B(T + 6000, T + 8500));
  assert.equal(rows()[0].speaker, "speaker_0");
});

test("a ranged row moved to another speaker drops the previous speaker's name", async (t) => {
  const { identify, final, rows } = await startMeeting(t);
  identify(A(T, T + 1000, "Ana"));
  final({ text: "hello", source: "system", timestamp: T + 500, endTimestamp: T + 8000 });
  assert.equal(rows()[0].speakerName, "Ana");
  identify(B(T + 1000, T + 8500));
  assert.equal(rows()[0].speaker, "speaker_1");
  assert.equal(rows()[0].speakerName, undefined);
});

test("a ranged row kept on the same speaker keeps its name when the new pick has none", async (t) => {
  const { identify, final, rows } = await startMeeting(t);
  identify(A(T, T + 2000, "Ana"));
  final({ text: "hello", source: "system", timestamp: T + 500, endTimestamp: T + 8000 });
  assert.equal(rows()[0].speakerName, "Ana");
  // Its end puts the named identification past retention, so the pick itself has no name.
  identify(A(T + 1000, T + 122_500, null));
  assert.equal(rows()[0].speaker, "speaker_0");
  assert.equal(rows()[0].speakerName, "Ana");
});

test("a ranged row heard by no identification yet is labelled by the next one", async (t) => {
  const { identify, final, rows } = await startMeeting(t);
  final({ text: "early", source: "system", timestamp: T + 500, endTimestamp: T + 4000 });
  assert.equal(rows()[0].speakerStatus, "provisional");
  identify(B(T, T + 4500, "Bo"));
  assert.equal(rows()[0].speaker, "speaker_1");
  assert.equal(rows()[0].speakerName, "Bo");
  assert.equal(rows()[0].speakerStatus, "confirmed");
});

test("a row the user locked is never relabelled", async (t) => {
  const { store, identify, final, rows } = await startMeeting(t);
  identify(A(T, T + 1000));
  final({ text: "hello", source: "system", timestamp: T + 500, endTimestamp: T + 8000 });
  store.lockSpeaker("speaker_0", "Ana");
  identify(B(T + 1000, T + 8500));
  assert.equal(rows()[0].speaker, "speaker_0");
  assert.equal(rows()[0].speakerName, "Ana");
});

test("a row without a range keeps the point-in-window rule", async (t) => {
  const { identify, final, rows } = await startMeeting(t);
  identify(A(T, T + 3000));
  identify(B(T + 3000, T + 9000));
  final({ text: "cloud", source: "system", timestamp: T + 2900 });
  assert.equal(rows()[0].speaker, "speaker_0");
  identify(B(T + 2000, T + 9500)); // contains the point, but the row is already confirmed
  assert.equal(rows()[0].speaker, "speaker_0");
});

test("a mic row with a range is not given a remote speaker", async (t) => {
  const { identify, final, rows } = await startMeeting(t);
  identify(A(T, T + 9000));
  final({ text: "mine", source: "mic", timestamp: T + 500, endTimestamp: T + 4000 });
  assert.notEqual(rows()[0].speaker, "speaker_0");
});

test("a row arriving 100 s after its audio still finds its speaker", async (t) => {
  const { identify, final, rows } = await startMeeting(t);
  identify(A(T, T + 5000));
  identify(B(T + 100_000, T + 101_000));
  final({ text: "late", source: "system", timestamp: T + 500, endTimestamp: T + 4500 });
  assert.equal(rows()[0].speaker, "speaker_0");
});

// One speech segment as the live identifier reports it (padded start T): the
// embedding hears A until T+5750, though B started talking at T+4000.
const inSegment = (speaker, endOffset) => speaker(T, T + endOffset, null);

test("a row first heard as the earlier speaker moves to the next one as their audio accumulates", async (t) => {
  const { identify, final, rows } = await startMeeting(t);
  for (const end of [1750, 2750, 3750, 4750, 5750]) identify(inSegment(A, end));
  final({ text: "over to you", source: "system", timestamp: T + 4000, endTimestamp: T + 9000 });
  assert.equal(rows()[0].speaker, "speaker_0");

  // 1 s of B against 1.75 s of A: still A.
  identify(inSegment(B, 6750));
  assert.equal(rows()[0].speaker, "speaker_0");

  identify(inSegment(B, 7750));
  assert.equal(rows()[0].speaker, "speaker_1");
});

test("a row in the earlier speaker's part keeps them as the next speaker is heard", async (t) => {
  const { identify, final, rows } = await startMeeting(t);
  for (const end of [1750, 2750, 3750, 4750, 5750]) identify(inSegment(A, end));
  final({ text: "my part", source: "system", timestamp: T + 750, endTimestamp: T + 4000 });
  for (const end of [6750, 7750, 8750, 9750]) identify(inSegment(B, end));
  assert.equal(rows()[0].speaker, "speaker_0");
});
