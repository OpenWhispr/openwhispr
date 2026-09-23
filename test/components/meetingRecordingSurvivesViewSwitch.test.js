const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

// #1685: switching notes or views mid-meeting must not stop the recording or
// lose its transcript. The pipeline lives in the store (#709) and the final
// save runs in the store's stop path (#1494), so whichever view is open when
// the pill's Stop is pressed, the note gets everything that was said.
//
// The shell below mirrors ControlPanel.tsx: MeetingRecordingMount is always
// mounted, and each view renders only while it is the active one. The store,
// Mount and PersonalNotesView are real; NoteEditor is a stub that records its
// mounts, because TipTap needs a real DOM.

const NOTES = {
  11: {
    id: 11,
    title: "Standup",
    content: "",
    transcript: "",
    folder_id: null,
    space_id: 1,
    note_type: "meeting",
  },
  12: {
    id: 12,
    title: "Other note",
    content: "",
    transcript: "",
    folder_id: null,
    space_id: 1,
    note_type: "personal",
  },
};

const MOCKS = {
  "/ui/useToast": `
    const toast = () => "1";
    export const useToast = () => ({ toast, dismiss() {} });
  `,
  "/icons": `export const Plus = () => null; export const Sparkles = () => null;`,
  "./NoteEditor": `
    import { useEffect } from "react";
    export default function NoteEditor(props) {
      globalThis.__editorProps = props;
      useEffect(() => {
        globalThis.__editorLog.push(["mount", props.note.id]);
        return () => globalThis.__editorLog.push(["unmount", props.note.id]);
      }, []);
      return null;
    }`,
  "./SpacesTree": `export default () => null;`,
  "/overview/ContainerOverview": `export const ContainerOverview = () => null;`,
  "./NotesStructureIntroDialog": `export default () => null;`,
  "./ActionPicker": `export default () => null;`,
  "./ActionManagerDialog": `export default () => null;`,
  "./AddNotesToFolderDialog": `export default () => null;`,
  "./NotesOnboarding": `export default () => null;`,
  "/hooks/useActionProcessing": `
    export const useActionProcessing = () => ({ state: "idle", actionName: null, runAction() {} });
  `,
  "/stores/actionStore": `export const useActions = () => [];`,
  "/hooks/useNotesOnboarding": `
    export const useNotesOnboarding = () => ({ isComplete: true, complete() {} });
  `,
  "/hooks/useTeamSpacesCapability": `export const useTeamSpacesCapability = () => false;`,
  "/hooks/useAuth": `export const useAuth = () => ({ isSignedIn: false, user: null });`,
  // Just enough of the note store for setActiveNoteId to drive note switches.
  "/stores/noteStore": `
    import { useSyncExternalStore } from "react";
    const state = { activeNoteId: 11 };
    const subscribers = new Set();
    const subscribe = (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    };
    const notes = () => globalThis.__notes;
    export const setActiveNoteId = (id) => {
      state.activeNoteId = id;
      subscribers.forEach((fn) => fn());
    };
    globalThis.__setActiveNoteId = setActiveNoteId;
    export const useActiveNoteId = () => useSyncExternalStore(subscribe, () => state.activeNoteId);
    export const useActiveNote = () =>
      useSyncExternalStore(subscribe, () => notes()[state.activeNoteId] ?? null);
    export const useNotes = () => [];
    export const useSpaces = () => [];
    export const useFolders = () => [];
    export const useActiveFolderId = () => null;
    export const useActiveContext = () => null;
    export const useIsTreeLoading = () => false;
    export const initializeNotes = async () => {};
    export const initializeNotesTree = async () => {};
    export const loadFolders = async () => {};
    export const setActiveContext = () => {};
    export const revealContainer = () => {};
    export const createFolder = async () => ({ success: false });
    export const getNoteFromStore = (id) => notes()[id] ?? null;
  `,
};

async function setup(t) {
  let root;
  let store;
  t.after(async () => {
    if (store) await React.act(async () => store.stopRecording());
    if (root) await React.act(async () => root.unmount());
    for (const key of ["__editorLog", "__editorProps", "__notes", "__setActiveNoteId"]) {
      delete globalThis[key];
    }
  });
  globalThis.__editorLog = [];
  globalThis.__notes = structuredClone(NOTES);

  const calls = { stop: 0, send: [], updateNote: [], trackStops: 0 };
  const listeners = {};
  const capture = (name) => (callback) => {
    listeners[name] = callback;
    return () => {
      if (listeners[name] === callback) listeners[name] = null;
    };
  };
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
      calls.stop += 1;
      return { success: true };
    },
    meetingTranscriptionSend: (_chunk, source) => calls.send.push(source),
    updateNote: async (id, updates) => {
      calls.updateNote.push([id, updates]);
      return { success: true };
    },
    getNote: async (id) => globalThis.__notes[id] ?? null,
    onMeetingTranscriptionSegment: capture("segment"),
    onMeetingSpeakerIdentified: capture("speaker"),
    onMeetingSpeakersMerged: capture("merged"),
    onMeetingSessionSpeakerConfigUpdated: capture("speakerConfig"),
    onMeetingTranscriptionError: capture("error"),
    onMeetingTranscriptionFatalError: capture("fatal"),
    onMeetingSystemAudioSilent: capture("silent"),
    onMeetingSystemAudioInterrupted: capture("interrupted"),
    onMeetingSystemAudioResumed: capture("resumed"),
    onMeetingAutoEndRequested: capture("autoEnd"),
    onMeetingDiarizationComplete: capture("diarization"),
  };
  installBrowserGlobals(t, {
    window: { electronAPI: api, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  installMicCaptureGlobals(t);
  // The mic track stopping is what "the recording stopped" means in hardware.
  const track = {
    readyState: "live",
    label: "Fake Mic",
    stop: () => (calls.trackStops += 1),
    getSettings: () => ({}),
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
  };
  globalThis.navigator.mediaDevices.getUserMedia = async () => stream;
  const worklets = [];
  const BaseWorklet = globalThis.AudioWorkletNode;
  globalThis.AudioWorkletNode = class extends BaseWorklet {
    constructor(...args) {
      super(...args);
      worklets.push(this);
    }
  };
  const container = installHostDom(t);
  globalThis.document.visibilityState = "visible";
  globalThis.document.hasFocus = () => true;

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-view-switch-test-",
    mockModules: MOCKS,
  });
  const { default: Mount } = await vite.ssrLoadModule("/components/MeetingRecordingMount.tsx");
  const { default: PersonalNotesView } = await vite.ssrLoadModule(
    "/components/notes/PersonalNotesView.tsx"
  );
  store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");

  const Home = () => React.createElement("div", null, "home");
  const Shell = ({ view }) =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement(Mount),
      view === "personal-notes" ? React.createElement(PersonalNotesView) : null,
      view === "home" ? React.createElement(Home) : null
    );
  root = createRoot(container);
  const show = (view) => React.act(async () => root.render(React.createElement(Shell, { view })));
  const openNote = (id) => React.act(async () => globalThis.__setActiveNoteId(id));
  const say = (text) =>
    React.act(async () =>
      listeners.segment?.({ text, source: "mic", type: "final", timestamp: Date.now() })
    );
  const micChunk = () => worklets[0].port.onmessage({ data: new ArrayBuffer(16) });
  const isRecording = () => store.useMeetingRecordingStore.getState().isRecording;
  return { store, show, openNote, say, micChunk, isRecording, calls };
}

test("#1685: switching views and notes mid-recording never stops the recording", async (t) => {
  const { store, show, openNote, say, micChunk, isRecording, calls } = await setup(t);
  await show("personal-notes");
  assert.deepEqual(globalThis.__editorLog, [["mount", 11]]);

  // The note's record button (NoteEditor -> onStartRecording).
  await React.act(async () => globalThis.__editorProps.onStartRecording());
  assert.equal(isRecording(), true);
  assert.equal(store.useMeetingRecordingStore.getState().recordingNoteId, 11);
  await say("first words");

  // Note switch: NoteEditor is keyed by note id, so it unmounts and remounts.
  await openNote(12);
  assert.deepEqual(globalThis.__editorLog.slice(-2), [
    ["unmount", 11],
    ["mount", 12],
  ]);
  assert.equal(isRecording(), true, "a note switch keeps recording");

  // Folder or space overview: no active note, so ContainerOverview replaces NoteEditor.
  await openNote(null);
  await openNote(12);
  assert.equal(isRecording(), true, "the overview keeps recording");

  // View switch: the whole notes view unmounts.
  await show("home");
  assert.deepEqual(globalThis.__editorLog.slice(-1), [["unmount", 12]]);
  assert.equal(isRecording(), true, "a view switch keeps recording");
  assert.equal(calls.stop, 0, "no meeting-transcription-stop was sent");
  assert.equal(calls.trackStops, 0, "the mic track was never stopped");

  // Audio keeps reaching main while the notes view is gone.
  const sentBefore = calls.send.length;
  micChunk();
  assert.deepEqual(calls.send.slice(sentBefore), ["mic"]);
  await say("said while on Home");

  // A view with nothing mounted, then back to the recording note.
  await show(null);
  await show("personal-notes");
  await openNote(11);
  assert.equal(globalThis.__editorProps.note.id, 11);
  assert.equal(globalThis.__editorProps.isRecording, true, "returning shows the live recording");
  assert.equal(calls.stop, 0);

  // The floating pill's Stop (MeetingRecordingPill calls stopRecording() with no
  // arguments) while another view is open: the transcript must still reach the note.
  await show("home");
  await React.act(async () => store.stopRecording());
  assert.equal(calls.stop, 1);
  const finalWrite = calls.updateNote
    .filter(([id, updates]) => id === 11 && typeof updates.transcript === "string")
    .at(-1);
  assert.ok(finalWrite, "final transcript persisted with the notes view unmounted");
  assert.match(finalWrite[1].transcript, /first words/);
  assert.match(finalWrite[1].transcript, /said while on Home/);
});

// Control: the counters above are not vacuous, because an explicit Stop registers.
test("#1685 control: the note's Stop button does stop and is counted", async (t) => {
  const { show, isRecording, calls } = await setup(t);
  await show("personal-notes");
  await React.act(async () => globalThis.__editorProps.onStartRecording());
  assert.equal(isRecording(), true);

  await React.act(async () => globalThis.__editorProps.onStopRecording());

  assert.equal(isRecording(), false);
  assert.equal(calls.stop, 1);
  assert.equal(calls.trackStops, 1);
});
