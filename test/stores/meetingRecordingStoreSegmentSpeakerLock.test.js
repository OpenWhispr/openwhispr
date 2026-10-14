const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// Reassigning single lines while the recording runs (#2353). A line the user
// corrected is the one speaker label the app knows is right, so nothing the
// session produces afterwards (later lines, live speaker identification, or
// naming the cluster the line came from) may relabel it.

const NOTE_ID = 42;
const START_ARGS = {
  noteId: NOTE_ID,
  noteTitle: "Weekly",
  folderId: null,
  autoEndEligible: true,
};

function createElectronAPI() {
  const noopListener = () => () => {};
  const listeners = {};
  const capture = (name) => (callback) => {
    listeners[name] = callback;
    return () => {
      if (listeners[name] === callback) listeners[name] = null;
    };
  };
  const writes = [];
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
    meetingTranscriptionStop: async () => ({ success: true }),
    meetingTranscriptionSend: () => {},
    getNote: async () => null,
    updateNote: async (id, patch) => {
      writes.push([id, patch]);
      return { success: true };
    },
    onMeetingTranscriptionSegment: capture("segment"),
    onMeetingSpeakerIdentified: capture("speakerIdentified"),
    onNoteDeleted: noopListener,
    onNoteSynced: noopListener,
    onMeetingSpeakersMerged: noopListener,
    onMeetingSessionSpeakerConfigUpdated: noopListener,
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
    onMeetingDiarizationComplete: noopListener,
  };
  return { api, listeners, writes };
}

async function loadStore(t, api) {
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: {
      electronAPI: api,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-segment-speaker-lock-test-",
  });
  return vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
}

const remote = (text, timestamp) => ({ text, source: "system", type: "final", timestamp });

const transcriptWrites = (writes) =>
  writes.filter(([, patch]) => typeof patch.transcript === "string");

const segments = (store) => store.useMeetingRecordingStore.getState().segments;
const byText = (store, text) => segments(store).find((segment) => segment.text === text);

// Two remote lines the live pass filed under one placeholder cluster, which is
// the shape the user is correcting: the second line was really someone else.
async function recordTwoRemoteLines(t) {
  const { api, listeners, writes } = createElectronAPI();
  const store = await loadStore(t, api);
  assert.equal(await store.startRecording(START_ARGS), true);
  listeners.segment(remote("that was my point", 1_000));
  listeners.segment(remote("no, mine", 2_000));
  for (const segment of segments(store)) {
    assert.equal(segment.speakerLocked, false, "lines start unlocked");
  }
  writes.length = 0;
  return { store, listeners, writes };
}

test("reassigning a line locks that line alone and persists it", async (t) => {
  const { store, writes } = await recordTwoRemoteLines(t);
  const mine = byText(store, "no, mine");

  store.lockSegmentSpeakers([mine.id], "Ana", 7);

  const corrected = byText(store, "no, mine");
  assert.equal(corrected.speakerName, "Ana");
  assert.equal(corrected.speakerLocked, true);
  assert.equal(corrected.speakerLockSource, "user");
  assert.equal(corrected.speakerStatus, "locked");
  assert.equal(corrected.suggestedProfileId, 7);

  const untouched = byText(store, "that was my point");
  assert.equal(untouched.speakerName, undefined, "the other line keeps its own label");
  assert.equal(untouched.speakerLocked, false);

  // A correction made early in a long call cannot wait for the periodic save.
  const flushed = transcriptWrites(writes);
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0][0], NOTE_ID);
  assert.match(flushed[0][1].transcript, /"speakerName":"Ana"/);
});

test("a correction survives the lines that arrive after it", async (t) => {
  const { store, listeners } = await recordTwoRemoteLines(t);
  store.lockSegmentSpeakers([byText(store, "no, mine").id], "Ana");

  listeners.segment(remote("and another thing", 3_000));

  const corrected = byText(store, "no, mine");
  assert.equal(corrected.speakerName, "Ana");
  assert.equal(corrected.speakerLocked, true);
});

test("live speaker identification does not relabel a corrected line", async (t) => {
  const { store, listeners } = await recordTwoRemoteLines(t);
  store.lockSegmentSpeakers([byText(store, "no, mine").id], "Ana");

  listeners.speakerIdentified({
    speakerId: "speaker_3",
    displayName: "Bruno",
    startTime: 0,
    endTime: 5_000,
  });

  const corrected = byText(store, "no, mine");
  assert.equal(corrected.speakerName, "Ana", "the human label outranks the voice match");
  assert.equal(byText(store, "that was my point").speakerName, "Bruno");
});

test("naming the cluster a corrected line came from leaves that line alone", async (t) => {
  const { store, listeners } = await recordTwoRemoteLines(t);
  listeners.speakerIdentified({
    speakerId: "speaker_0",
    displayName: null,
    startTime: 0,
    endTime: 5_000,
  });
  store.lockSegmentSpeakers([byText(store, "no, mine").id], "Ana");

  store.lockSpeaker("speaker_0", "Bruno");

  assert.equal(byText(store, "that was my point").speakerName, "Bruno");
  assert.equal(byText(store, "no, mine").speakerName, "Ana");
});

test("stopping the recording persists the correction", async (t) => {
  const { store, writes } = await recordTwoRemoteLines(t);
  store.lockSegmentSpeakers([byText(store, "no, mine").id], "Ana");
  writes.length = 0;

  await store.stopRecording();

  const written = transcriptWrites(writes).at(-1)[1].transcript;
  const stored = JSON.parse(written).find((segment) => segment.text === "no, mine");
  assert.equal(stored.speakerName, "Ana");
  assert.equal(stored.speakerLocked, true);
  assert.equal(stored.speakerLockSource, "user");
});

test("reassigning without a name or without lines changes nothing", async (t) => {
  const { store, writes } = await recordTwoRemoteLines(t);
  const before = segments(store);

  store.lockSegmentSpeakers([byText(store, "no, mine").id], "");
  store.lockSegmentSpeakers([], "Ana");

  assert.deepEqual(segments(store), before);
  assert.deepEqual(transcriptWrites(writes), []);
});
