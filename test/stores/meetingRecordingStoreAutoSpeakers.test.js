const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// With no speaker count set, main holds a new voice as a candidate and only
// confirms it once it has been heard enough. Its earlier lines were carried onto
// the previous speaker meanwhile, so the confirmation relabels them, and the
// stepper follows the number of confirmed speakers until the user presses it.

const T = 1_800_000_000_000;
const PUSH_CONFIG_DEBOUNCE_MS = 150;
const START_ARGS = {
  noteId: 41,
  noteTitle: "Sync",
  folderId: null,
  autoEndEligible: true,
};

function createElectronAPI() {
  const noopListener = () => () => {};
  const state = { segmentCallback: null, speakerCallback: null, configCallback: null };
  const api = {
    pushedConfigs: [],
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
    setMeetingSessionSpeakerConfig: (config) => {
      api.pushedConfigs.push(config);
    },
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
    onMeetingSessionSpeakerConfigUpdated: (callback) => {
      state.configCallback = callback;
      return () => {
        state.configCallback = null;
      };
    },
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
  };
  return { api, state };
}

async function startMeeting(t, startArgs = {}) {
  const { api, state } = createElectronAPI();
  let store = null;
  // Registered before the globals so the recording stops while `window` still exists.
  t.after(() => store?.stopRecording());
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-auto-speakers-test-",
  });
  store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  assert.equal(await store.startRecording({ ...START_ARGS, ...startArgs }), true);
  return {
    api,
    identify: (identification) => state.speakerCallback(identification),
    final: (segment) => state.segmentCallback({ type: "final", ...segment }),
    partial: (segment) => state.segmentCallback({ type: "partial", ...segment }),
    configUpdated: (config) => state.configCallback(config),
    lockSpeaker: store.lockSpeaker,
    setSessionExpectedCount: store.setSessionExpectedCount,
    store: () => store.useMeetingRecordingStore.getState(),
    rows: () => store.useMeetingRecordingStore.getState().segments,
  };
}

const flushPushConfig = () =>
  new Promise((resolve) => setTimeout(resolve, PUSH_CONFIG_DEBOUNCE_MS + 50));

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

test("a retroactive identification relabels provisional rows and leaves the current speaker alone", async (t) => {
  const { identify, final, partial, store, rows } = await startMeeting(t);
  identify(A(T, T + 5000));
  final({ text: "new voice", source: "system", timestamp: T + 8000 }); // carried onto speaker_0, provisional
  partial({ text: "still", source: "system" });
  assert.equal(store().systemPartialSpeakerId, "speaker_0");
  identify({ ...B(T + 7000, T + 10_000), retroactive: true });
  assert.equal(rows()[0].speaker, "speaker_1");
  assert.equal(rows()[0].speakerStatus, "confirmed");
  assert.equal(store().systemPartialSpeakerId, "speaker_0");

  // The next line is still carried onto the speaker main was last sure of.
  final({ text: "carried on", source: "system", timestamp: T + 15_000 });
  assert.equal(rows()[1].speaker, "speaker_0");
});

test("a retroactive identification relabels a ranged row", async (t) => {
  const { identify, final, store, rows } = await startMeeting(t);
  identify(A(T, T + 5000));
  final({ text: "new voice", source: "system", timestamp: T + 6000, endTimestamp: T + 9000 });
  assert.equal(rows()[0].speakerStatus, "provisional");
  identify({ ...B(T + 6000, T + 9000), retroactive: true });
  assert.equal(rows()[0].speaker, "speaker_1");
  assert.equal(rows()[0].speakerStatus, "confirmed");
  assert.equal(store().systemPartialSpeakerId, null);
});

test("a line only carried onto a named speaker is not locked, and moves on promotion", async (t) => {
  const { identify, final, lockSpeaker, rows } = await startMeeting(t);
  identify(A(T, T + 5000));
  final({ text: "ana speaking", source: "system", timestamp: T + 1000 });
  lockSpeaker("speaker_0", "Ana");
  final({ text: "new voice", source: "system", timestamp: T + 8000 });
  assert.equal(rows()[1].speakerName, "Ana");
  assert.notEqual(rows()[1].speakerLocked, true);
  identify({ ...B(T + 7000, T + 10_000), retroactive: true });
  assert.equal(rows()[1].speaker, "speaker_1");
  // Ana's name stays with Ana.
  assert.equal(rows()[1].speakerName, undefined);
  assert.notEqual(rows()[1].speakerLocked, true);
  assert.equal(rows()[0].speakerLocked, true);
});

test("a line confirmed for a named speaker is locked", async (t) => {
  const { identify, final, lockSpeaker, rows } = await startMeeting(t);
  identify(A(T, T + 5000));
  lockSpeaker("speaker_0", "Ana");
  final({ text: "confirmed later", source: "system", timestamp: T + 8000 });
  assert.notEqual(rows()[0].speakerLocked, true);
  identify(A(T + 7000, T + 10_000));
  assert.equal(rows()[0].speakerLocked, true);
  assert.equal(rows()[0].speakerName, "Ana");
});

test("a line that arrives already confirmed for a named speaker is locked", async (t) => {
  const { identify, final, lockSpeaker, rows } = await startMeeting(t);
  identify(A(T, T + 5000));
  lockSpeaker("speaker_0", "Ana");
  final({ text: "inside", source: "system", timestamp: T + 2000 });
  assert.equal(rows()[0].speakerLocked, true);
  assert.equal(rows()[0].speakerName, "Ana");
});

// An identification's window is padded 750 ms each side, so a reply that starts
// right after a speaker stops falls inside that speaker's window.
const spoke = (identification, speechStartTime, speechEndTime) => ({
  ...identification,
  speechStartTime,
  speechEndTime,
});
const anaThenQuickReply = (identify, final) => {
  identify(spoke(A(T, T + 5750), T + 750, T + 5000));
  final({ text: "quick reply", source: "system", timestamp: T + 5400 });
};
const replyConfirmed = () => ({
  ...spoke(B(T + 4650, T + 7750), T + 5400, T + 7000),
  retroactive: true,
});

test("a reply confirmed by the previous speaker's padding moves to the voice it starts in", async (t) => {
  const { identify, final, rows } = await startMeeting(t);
  anaThenQuickReply(identify, final);
  assert.equal(rows()[0].speaker, "speaker_0");
  assert.equal(rows()[0].speakerStatus, "confirmed");

  identify(replyConfirmed());
  assert.equal(rows()[0].speaker, "speaker_1");
});

test("a line in a speaker's own speech stays theirs when another window's padding covers it", async (t) => {
  const { identify, final, rows } = await startMeeting(t);
  identify(spoke(A(T, T + 5750), T + 750, T + 5000));
  final({ text: "ana's last words", source: "system", timestamp: T + 4800 });
  identify(replyConfirmed());
  assert.equal(rows()[0].speaker, "speaker_0");
});

test("a reply confirmed by a named speaker's padding is not locked, and moves", async (t) => {
  const { identify, final, lockSpeaker, rows } = await startMeeting(t);
  lockSpeaker("speaker_0", "Ana");
  anaThenQuickReply(identify, final);
  assert.equal(rows()[0].speakerName, "Ana");
  assert.notEqual(rows()[0].speakerLocked, true);

  identify(replyConfirmed());
  assert.equal(rows()[0].speaker, "speaker_1");
  assert.equal(rows()[0].speakerName, undefined);
});

test("a line confirmed by padding is locked once its named speaker is heard in it", async (t) => {
  const { identify, final, lockSpeaker, rows } = await startMeeting(t);
  lockSpeaker("speaker_0", "Ana");
  anaThenQuickReply(identify, final);
  identify(spoke(A(T + 4650, T + 9000), T + 5400, T + 8250));
  assert.equal(rows()[0].speakerLocked, true);
  assert.equal(rows()[0].speakerName, "Ana");
});

// By the time a long-held voice is confirmed, the identifications that gave a
// ranged row its speaker are pruned, so the old window is the only one left.
test("a late retroactive window that only clips a confirmed ranged row leaves it", async (t) => {
  const { identify, final, rows } = await startMeeting(t);
  identify(A(T, T + 6000));
  final({ text: "ana at length", source: "system", timestamp: T + 1000, endTimestamp: T + 5200 });
  identify(A(T + 200_000, T + 201_000));

  identify({ ...B(T + 5000, T + 6000), retroactive: true });
  assert.equal(rows()[0].speaker, "speaker_0");

  identify({ ...B(T + 2000, T + 6000), retroactive: true });
  assert.equal(rows()[0].speaker, "speaker_1");
});

test("an automatic count update moves an untouched stepper up and down", async (t) => {
  const { configUpdated, store } = await startMeeting(t);
  configUpdated({ enabled: true, expectedCount: 4, auto: true });
  assert.equal(store().sessionExpectedCount, 4);
  configUpdated({ enabled: true, expectedCount: 3, auto: true });
  assert.equal(store().sessionExpectedCount, 3);
});

test("an automatic count update is ignored once the stepper was pressed", async (t) => {
  const { configUpdated, setSessionExpectedCount, store } = await startMeeting(t);
  setSessionExpectedCount(5);
  configUpdated({ enabled: true, expectedCount: 3, auto: true });
  assert.equal(store().sessionExpectedCount, 5);
});

test("a press starts from the followed count and is sent as explicit", async (t) => {
  const { api, configUpdated, setSessionExpectedCount, store } = await startMeeting(t);
  configUpdated({ enabled: true, expectedCount: 4, auto: true });
  setSessionExpectedCount(store().sessionExpectedCount + 1);
  await flushPushConfig();
  assert.deepEqual(api.pushedConfigs.at(-1), {
    enabled: true,
    expectedCount: 5,
    countIsExplicit: true,
  });
});

test("naming a speaker doesn't lock a line only carried onto them", async (t) => {
  const { identify, final, lockSpeaker, rows } = await startMeeting(t);
  identify(A(T, T + 5000));
  final({ text: "ana speaking", source: "system", timestamp: T + 1000 });
  final({ text: "new voice", source: "system", timestamp: T + 8000 }); // carried onto speaker_0
  lockSpeaker("speaker_0", "Ana");
  assert.equal(rows()[1].speakerName, "Ana");
  assert.notEqual(rows()[1].speakerLocked, true);
  identify({ ...B(T + 7000, T + 10_000), retroactive: true });
  assert.equal(rows()[1].speaker, "speaker_1");
  assert.equal(rows()[1].speakerName, undefined);
  assert.notEqual(rows()[1].speakerLocked, true);
  assert.equal(rows()[0].speakerLocked, true);
  assert.equal(rows()[0].speakerName, "Ana");
});

test("naming an earlier session's speaker locks its lines, which nothing can confirm now", async (t) => {
  const seedSegments = [
    {
      id: "s0",
      text: "from last time",
      source: "system",
      timestamp: Date.now() - 60_000,
      speaker: "speaker_0",
      speakerIsPlaceholder: true,
    },
  ];
  const { lockSpeaker, rows } = await startMeeting(t, { seedSegments });
  lockSpeaker("speaker_0", "Carol");
  assert.equal(rows()[0].speakerName, "Carol");
  assert.equal(rows()[0].speakerLocked, true);
});

// A speaker's identification window runs past their last word, so a new voice that
// answers inside it has no identification yet and its local-model row is picked for
// the previous speaker from that sliver. The row must stay movable, or the later
// retroactive window could never reach it while main moves its own copy.
test("a ranged row picked for a named speaker is named without locking, and moves on promotion", async (t) => {
  const { identify, final, lockSpeaker, rows } = await startMeeting(t);
  identify(A(T, T + 5000));
  lockSpeaker("speaker_0", "Ana");
  final({ text: "new voice", source: "system", timestamp: T + 4500, endTimestamp: T + 10_000 });
  assert.equal(rows()[0].speaker, "speaker_0");
  assert.equal(rows()[0].speakerName, "Ana");
  assert.notEqual(rows()[0].speakerLocked, true);
  identify({ ...B(T + 3750, T + 10_750), retroactive: true });
  assert.equal(rows()[0].speaker, "speaker_1");
  assert.notEqual(rows()[0].speakerName, "Ana");
  assert.notEqual(rows()[0].speakerLocked, true);
});

test("naming a speaker doesn't lock their ranged rows", async (t) => {
  const { identify, final, lockSpeaker, rows } = await startMeeting(t);
  identify(A(T, T + 5000));
  final({ text: "new voice", source: "system", timestamp: T + 4500, endTimestamp: T + 10_000 });
  lockSpeaker("speaker_0", "Ana");
  assert.equal(rows()[0].speakerName, "Ana");
  assert.notEqual(rows()[0].speakerLocked, true);
  identify({ ...B(T + 3750, T + 10_750), retroactive: true });
  assert.equal(rows()[0].speaker, "speaker_1");
  assert.notEqual(rows()[0].speakerName, "Ana");
});

test("a ranged row confirmed again for its named speaker keeps the name, unlocked", async (t) => {
  const { identify, final, lockSpeaker, rows } = await startMeeting(t);
  identify(A(T, T + 5000));
  lockSpeaker("speaker_0", "Ana");
  final({ text: "ana again", source: "system", timestamp: T + 4500, endTimestamp: T + 10_000 });
  identify(A(T + 5000, T + 10_000));
  assert.equal(rows()[0].speaker, "speaker_0");
  assert.equal(rows()[0].speakerName, "Ana");
  assert.notEqual(rows()[0].speakerLocked, true);
});

test("the store says whether the session hears system audio, for the stepper hint", async (t) => {
  const { store } = await startMeeting(t);
  assert.equal(store().sessionSystemAudioActive, true);
});
