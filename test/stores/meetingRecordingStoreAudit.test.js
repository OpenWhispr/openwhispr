const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// #3029: main writes the local audit log, so the renderer tells it where a
// recording started from, why it stopped, and when it refused a start itself.

const NOTE_ID = 31;

function createElectronAPI() {
  const noopListener = () => () => {};
  const calls = { starts: [], stops: [], refusals: [] };
  const api = {
    checkSystemAudioAccess: async () => ({
      granted: true,
      status: "granted",
      mode: "native",
      strategy: "native",
    }),
    meetingTranscriptionStart: async (options) => {
      calls.starts.push(options);
      return { success: true, systemAudioMode: "native", systemAudioStrategy: "native" };
    },
    meetingTranscriptionSetSystemAudioAvailable: async () => ({ success: true }),
    meetingTranscriptionStop: async (sessionId, reason) => {
      calls.stops.push({ sessionId, reason });
      return { success: true, transcript: "" };
    },
    meetingRecordingRefused: async (details) => {
      calls.refusals.push(details);
    },
    meetingTranscriptionSend: () => {},
    getNote: async () => null,
    updateNote: async () => ({ success: true }),
    onMeetingTranscriptionSegment: noopListener,
    onNoteDeleted: noopListener,
    onNoteSynced: noopListener,
    onMeetingSpeakerIdentified: noopListener,
    onMeetingSpeakersMerged: noopListener,
    onMeetingSessionSpeakerConfigUpdated: noopListener,
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
    onMeetingDiarizationComplete: noopListener,
  };
  return { api, calls };
}

async function load(t, api) {
  installMicCaptureGlobals(t);
  installBrowserGlobals(t, {
    window: {
      electronAPI: api,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-meeting-audit-test-" });
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { startRecordingForNote } = await vite.ssrLoadModule("/hooks/useCreateNote.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  return { store, startRecordingForNote, usePolicyStore };
}

const note = {
  id: NOTE_ID,
  title: "Planning",
  folder_id: null,
  transcript: null,
  diarization_enabled: null,
  expected_speaker_count: null,
};

test("a start tells main where it came from, and a stop why it ended", async (t) => {
  const { api, calls } = createElectronAPI();
  const { store, startRecordingForNote } = await load(t, api);

  assert.equal(await startRecordingForNote(note, undefined, "record-button"), true);
  await store.stopRecording(undefined, "auto-end");
  assert.equal(await startRecordingForNote(note, undefined, "new-note"), true);
  await store.stopRecording();

  assert.deepEqual(
    calls.starts.map((options) => [options.noteId, options.startSource]),
    [
      [NOTE_ID, "record-button"],
      [NOTE_ID, "new-note"],
    ]
  );
  assert.deepEqual(
    calls.stops.map((stop) => stop.reason),
    ["auto-end", "user"]
  );
});

test("a start the renderer refuses is reported to main with its code", async (t) => {
  const { api, calls } = createElectronAPI();
  const { startRecordingForNote, usePolicyStore } = await load(t, api);
  const scope = {
    allowedModes: ["local"],
    allowedByokProviders: [],
    allowedEnterpriseProviders: [],
  };
  usePolicyStore.setState({
    status: "managed",
    appVersion: "1.11.1",
    policy: {
      version: 1,
      transcription: scope,
      llm: scope,
      features: { meetingRecordingEnabled: false },
      sharing: { externalLinkSharing: "disabled" },
      dataRetention: {
        audioRetentionMaxDays: null,
        localHistoryMode: "user_choice",
        cloudBackupAllowed: false,
      },
      minAppVersion: null,
    },
  });

  assert.equal(await startRecordingForNote(note, undefined, "record-button"), false);

  assert.deepEqual(calls.starts, []);
  assert.deepEqual(calls.refusals, [
    { noteId: NOTE_ID, startSource: "record-button", reason: "POLICY_MEETING_RECORDING_DISABLED" },
  ]);
});

test("a start the administrator's managed preference disables is reported to main", async (t) => {
  const { api, calls } = createElectronAPI();
  api.isMeetingRecordingDisabled = async () => true;
  const { startRecordingForNote } = await load(t, api);

  assert.equal(await startRecordingForNote(note, undefined, "new-note"), false);

  assert.deepEqual(calls.starts, []);
  assert.deepEqual(calls.refusals, [
    { noteId: NOTE_ID, startSource: "new-note", reason: "POLICY_MEETING_RECORDING_DISABLED" },
  ]);
});
