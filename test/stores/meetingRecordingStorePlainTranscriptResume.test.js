const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// Some notes store their transcript as plain text rather than a JSON segment
// array: meetings recorded on v1.6.0–v1.6.5, and recordings that captured no
// segments (main's joined text is saved on stop). Recording again into such a
// note seeds the session from that transcript; every save then writes the
// session's segments over it, so the seed must carry the old text.

const NOTE_ID = 21;
const OLD_TRANSCRIPT = "We agreed to ship on Friday.\nDana owns the release notes.";

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
    meetingTranscriptionStop: async () => ({ success: true, transcript: "joined by main" }),
    meetingTranscriptionSend: () => {},
    getNote: async () => null,
    updateNote: async (id, patch) => {
      writes.push([id, patch]);
      return { success: true };
    },
    onMeetingTranscriptionSegment: capture("segment"),
    onNoteDeleted: noopListener,
    onNoteSynced: noopListener,
    onMeetingSpeakerIdentified: noopListener,
    onMeetingSpeakersMerged: noopListener,
    onMeetingSessionSpeakerConfigUpdated: noopListener,
    onMeetingTranscriptionError: noopListener,
    onMeetingTranscriptionFatalError: noopListener,
    onMeetingSystemAudioSilent: noopListener,
    onMeetingDiarizationComplete: capture("diarization"),
  };
  return { api, listeners, writes };
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
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-plain-transcript-resume-test-",
  });
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { startRecordingForNote } = await vite.ssrLoadModule("/hooks/useCreateNote.ts");
  const { parseTranscriptSegments, parseSeedSegments } = await vite.ssrLoadModule(
    "/utils/parseTranscriptSegments.ts"
  );
  return { store, startRecordingForNote, parseTranscriptSegments, parseSeedSegments };
}

const note = (transcript) => ({
  id: NOTE_ID,
  title: "Planning",
  folder_id: null,
  transcript,
  diarization_enabled: null,
  expected_speaker_count: null,
});

const final = (text) => ({ text, source: "mic", type: "final", timestamp: Date.now() });

const transcriptWrites = (writes) =>
  writes.filter(([, patch]) => typeof patch.transcript === "string").map(([, patch]) => patch);

test("recording again into a plain-text transcript keeps the old text", async (t) => {
  const { api, listeners, writes } = createElectronAPI();
  const { store, startRecordingForNote, parseTranscriptSegments } = await load(t, api);

  assert.equal(await startRecordingForNote(note(OLD_TRANSCRIPT)), true);
  listeners.segment(final("Picking up where we left off."));

  await store.persistLiveTranscript();
  await store.stopRecording();

  const saved = transcriptWrites(writes);
  assert.equal(saved.length, 2, "the 30-second save and the stop each write once");
  for (const { transcript } of saved) {
    const segments = parseTranscriptSegments(transcript);
    assert.deepEqual(
      segments.map((segment) => segment.text),
      [OLD_TRANSCRIPT, "Picking up where we left off."],
      "the old transcript comes first, then the new session"
    );
    // No timestamp: it keeps the old text out of live speaker identification
    // and off the export's epoch rebase, and sorts it ahead of new finals.
    assert.equal(segments[0].timestamp, undefined);
    assert.equal(segments[0].speaker, undefined);
  }
});

test("a resumed plain-text note with no new segments keeps the old text", async (t) => {
  const { api, writes } = createElectronAPI();
  api.meetingTranscriptionStop = async () => ({ success: true, transcript: "" });
  const { store, startRecordingForNote, parseTranscriptSegments } = await load(t, api);

  assert.equal(await startRecordingForNote(note(OLD_TRANSCRIPT)), true);
  await store.stopRecording();

  const saved = transcriptWrites(writes);
  assert.equal(saved.length, 1);
  assert.deepEqual(
    parseTranscriptSegments(saved[0].transcript).map((segment) => segment.text),
    [OLD_TRANSCRIPT]
  );
});

test("a resumed note keeps old text and main's stop-only text after an empty completion", async (t) => {
  const { api, listeners, writes } = createElectronAPI();
  const fallback = "New text returned only at stop.";
  api.meetingTranscriptionStop = async () => ({
    success: true,
    transcript: fallback,
    diarizationSessionId: "diar-stop-only",
  });
  const { store, startRecordingForNote, parseTranscriptSegments } = await load(t, api);

  assert.equal(await startRecordingForNote(note(OLD_TRANSCRIPT)), true);
  await store.stopRecording();
  listeners.diarization({ noteId: NOTE_ID, sessionId: "diar-stop-only", segments: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(
    parseTranscriptSegments(transcriptWrites(writes).at(-1).transcript).map(({ text }) => text),
    [OLD_TRANSCRIPT, fallback]
  );
});

test("seed segments come from a note's stored transcript", async (t) => {
  const { api } = createElectronAPI();
  const { parseSeedSegments } = await load(t, api);

  assert.deepEqual(parseSeedSegments(null), []);
  assert.deepEqual(parseSeedSegments(""), []);
  assert.deepEqual(parseSeedSegments("  \n "), []);
  assert.deepEqual(parseSeedSegments("[]"), [], "an empty segment array has nothing to keep");

  const stored = JSON.stringify([{ text: "hi", source: "mic", timestamp: 5 }]);
  assert.deepEqual(
    parseSeedSegments(stored).map(({ text, source, timestamp }) => ({ text, source, timestamp })),
    [{ text: "hi", source: "mic", timestamp: 5 }]
  );

  // Plain text can open with a bracket ("[Music] …"), which isn't JSON.
  for (const plain of [OLD_TRANSCRIPT, "[Music] and then we started"]) {
    const [legacy, ...rest] = parseSeedSegments(`  ${plain}\n`);
    assert.equal(rest.length, 0);
    assert.equal(legacy.text, plain);
    assert.equal(legacy.source, "system");
    assert.equal(legacy.timestamp, undefined);
    assert.ok(legacy.id);
  }
});
