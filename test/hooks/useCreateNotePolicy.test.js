const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("new notes stay open without recording when policy changes during save", async (t) => {
  const saved = Promise.withResolvers();
  const starts = [];
  const opened = [];
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { window: { electronAPI: { saveNote: () => saved.promise } } });
  const container = installHookDom(t);
  globalThis.__notePolicyTest = { allowed: true, starts, opened };
  t.after(() => delete globalThis.__notePolicyTest);
  const vite = await createRendererServer(t, {
    cachePrefix: "new-note-policy-",
    mockModules: {
      "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
      "./usePolicy": `export const useTranscriptionContextAllowed = () => true;
      export const useMeetingAutoTranscriptionCheck = () => () => globalThis.__notePolicyTest.allowed;`,
      "/stores/meetingRecordingStore": `export const useMeetingRecordingStore = (select) => select({isRecording:false});
      export const startRecording = async (args) => { globalThis.__notePolicyTest.starts.push(args); return true; };`,
      "/stores/noteStore": `export const useActiveContext = () => null;
      export const revealContainer = () => {}; export const setActiveContext = () => {};
      export const setActiveNoteId = (id) => globalThis.__notePolicyTest.opened.push(id);`,
    },
  });
  const { useCreateNote, startRecordingForNote } =
    await vite.ssrLoadModule("/hooks/useCreateNote.ts");
  let createNote;
  function Harness() {
    ({ createNote } = useCreateNote());
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const pending = createNote();
  globalThis.__notePolicyTest.allowed = false;
  const note = { id: 41, title: "Note", space_id: 1, folder_id: null };
  await React.act(async () => {
    saved.resolve({ success: true, note });
    await pending;
  });
  assert.deepEqual(opened, [41]);
  assert.deepEqual(starts, []);
  globalThis.__notePolicyTest.allowed = true;
  await React.act(async () => {
    await createNote();
  });
  assert.equal(starts.length, 1);
  assert.equal(typeof starts[0].canAutoStart, "function");
  // Explicit Record does not receive the automatic-only guard.
  await startRecordingForNote(note);
  assert.equal(starts[1].canAutoStart, undefined);
});
