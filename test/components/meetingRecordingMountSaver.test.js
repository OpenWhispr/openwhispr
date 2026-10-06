const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// The 30-second crash-safety save lives in the always-mounted Mount, so it
// keeps running whichever view is open. It writes through the store's
// persistLiveTranscript: the same save the unload flush makes.

const NOTE_ID = 11;
const START_ARGS = {
  noteId: NOTE_ID,
  noteTitle: "Standup",
  folderId: null,
  autoEndEligible: true,
};
const TOAST_MOCK = `
  const toast = () => "1";
  const dismiss = () => {};
  export const useToast = () => ({ toast, dismiss });
`;

async function setup(t) {
  let root;
  let store;
  t.after(async () => {
    if (store) await React.act(async () => store.stopRecording());
    if (root) await React.act(async () => root.unmount());
  });
  const listeners = {};
  const capture = (name) => (callback) => {
    listeners[name] = callback;
    return () => {
      if (listeners[name] === callback) listeners[name] = null;
    };
  };
  const noop = () => () => {};
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
    meetingTranscriptionSend() {},
    updateNote: async (id, patch) => {
      writes.push([id, patch]);
      return { success: true };
    },
    onMeetingTranscriptionSegment: capture("segment"),
    onNoteDeleted: capture("noteDeleted"),
    onMeetingSpeakerIdentified: noop,
    onMeetingSpeakersMerged: noop,
    onMeetingSessionSpeakerConfigUpdated: noop,
    onMeetingTranscriptionError: noop,
    onMeetingTranscriptionFatalError: noop,
    onMeetingSystemAudioSilent: noop,
    onMeetingAutoEndRequested: noop,
  };
  installBrowserGlobals(t, {
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  installMicCaptureGlobals(t);
  const container = installHookDom(t);
  globalThis.document.visibilityState = "visible";
  globalThis.document.hasFocus = () => true;
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-mount-saver-test-",
    mockModules: { "/ui/useToast": TOAST_MOCK },
  });
  const { default: Mount } = await vite.ssrLoadModule("/components/MeetingRecordingMount.tsx");
  store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  t.mock.timers.enable({ apis: ["setInterval"] });
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Mount)));

  const start = () => React.act(async () => store.startRecording(START_ARGS));
  const say = (text) =>
    React.act(async () =>
      listeners.segment({ text, source: "mic", type: "final", timestamp: Date.now() })
    );
  const deleteNote = (id) => listeners.noteDeleted?.({ id });
  const tick = (ms) => React.act(async () => t.mock.timers.tick(ms));
  const savedTranscripts = () =>
    writes.filter(([, patch]) => typeof patch.transcript === "string");
  return { start, say, deleteNote, tick, writes, savedTranscripts };
}

test("the 30-second save writes the live transcript while a recording runs", async (t) => {
  const { start, say, tick, writes, savedTranscripts } = await setup(t);
  await start();
  await say("halfway through the meeting");
  writes.length = 0;

  await tick(30_000);

  const saved = savedTranscripts();
  assert.equal(saved.length, 1);
  assert.equal(saved[0][0], NOTE_ID);
  assert.match(saved[0][1].transcript, /halfway through the meeting/);
});

test("the 30-second save skips a note deleted mid-recording", async (t) => {
  const { start, say, deleteNote, tick, writes, savedTranscripts } = await setup(t);
  await start();
  await say("said before the delete");
  deleteNote(NOTE_ID);
  writes.length = 0;

  await tick(30_000);

  assert.deepEqual(savedTranscripts(), [], "a deleted note is not written back");
});
