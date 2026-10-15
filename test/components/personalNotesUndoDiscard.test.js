const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

// PersonalNotesView's delayed saves, seen through the props it hands the
// editor. PersonalNotesView is real; NoteEditor is a stub that exposes them.

const NOTE = {
  id: 11,
  title: "Standup",
  content: "Notes",
  enhanced_content: "Summary",
  transcript: "",
  folder_id: null,
  space_id: 1,
  note_type: "meeting",
};

const MOCKS = {
  "/ui/useToast": `
    const toast = () => "1";
    export const useToast = () => ({ toast, dismiss() {} });
  `,
  "/icons": `export const Plus = () => null; export const Sparkles = () => null;`,
  "./NoteEditor": `
    export default function NoteEditor(props) {
      globalThis.__editorProps = props;
      return null;
    }`,
  "./SpacesTree": `export default () => null;`,
  "/overview/ContainerOverview": `export const ContainerOverview = () => null;`,
  "./NotesStructureIntroDialog": `export default () => null;`,
  "./ActionManagerDialog": `export default () => null;`,
  "./AddNotesToFolderDialog": `export default () => null;`,
  "./NotesOnboarding": `export default () => null;`,
  "/hooks/useActionProcessing": `
    export const useActionProcessing = () => ({ state: "idle", actionName: null, runAction() {} });
  `,
  "/stores/actionStore": `export const getActionName = (action) => action.name;`,
  "/hooks/useNotesOnboarding": `
    export const useNotesOnboarding = () => ({ isComplete: true, complete() {} });
  `,
  "/hooks/useTeamSpacesCapability": `export const useTeamSpacesCapability = () => false;`,
  "/hooks/useAuth": `export const useAuth = () => ({ isSignedIn: false, user: null });`,
  "/stores/noteStore": `
    const note = () => globalThis.__note;
    export const setActiveNoteId = () => {};
    export const useActiveNoteId = () => note().id;
    export const useActiveNote = () => note();
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
    export const getNoteFromStore = () => note();
  `,
};

async function mountView(t, updateNote) {
  const calls = [];
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__editorProps;
    delete globalThis.__note;
  });
  globalThis.__note = NOTE;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getNote: async () => NOTE,
        updateNote: async (...args) => {
          calls.push(["save", ...args]);
          return updateNote ? updateNote(...args) : { success: true };
        },
        discardNoteUndo: async (...args) => calls.push(["discard", ...args]),
      },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
    },
  });
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-personal-notes-undo-discard-",
    mockModules: MOCKS,
  });
  const { default: PersonalNotesView } = await vite.ssrLoadModule(
    "/components/notes/PersonalNotesView.tsx"
  );
  root = createRoot(container);
  const render = () => React.act(async () => root.render(React.createElement(PersonalNotesView)));
  await render();
  // Re-renders with the store's current note (globalThis.__note).
  Object.defineProperty(calls, "rerender", { value: render });
  return calls;
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const saves = (calls) => calls.filter(([kind]) => kind === "save");

// Typing in the open note retires the assistant's Undo at once, before the
// editor's delayed save: an Undo clicked in that second would restore the
// assistant's previous text over what the user just typed.
test("editing either document retires the assistant's Undo before the delayed save", async (t) => {
  const calls = await mountView(t);

  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Typed"));
  assert.deepEqual(calls, [["discard", NOTE.id]], "retired before the save");
  await React.act(async () =>
    globalThis.__editorProps.enhancement.onChange(NOTE.id, "Typed summary")
  );
  assert.deepEqual(calls.at(-1), ["discard", NOTE.id]);
  assert.equal(saves(calls).length, 0);
});

// Keep on the conflict banner saves the draft first: a delayed save landing
// after Keep would write it back over a clear Keep accepted.
test("a flush before Keep saves the pending edits at once, and nothing lands later", async (t) => {
  const calls = await mountView(t);

  await React.act(async () => globalThis.__editorProps.onTitleChange(NOTE.id, "Retitled"));
  await React.act(async () => globalThis.__editorProps.onFlushPendingSaves(NOTE.id));
  assert.deepEqual(saves(calls), [["save", NOTE.id, { title: "Retitled" }]]);
  await React.act(() => settle(1100));
  assert.equal(saves(calls).length, 1, "the delayed save was retired");
});

test("a flush that fails rejects and leaves the edits pending", async (t) => {
  const calls = await mountView(t, () => ({ success: false, error: "Note not found" }));

  await React.act(async () => globalThis.__editorProps.onTitleChange(NOTE.id, "Retitled"));
  await assert.rejects(globalThis.__editorProps.onFlushPendingSaves(NOTE.id), /Note not found/);
  await React.act(() => settle(1100));
  assert.equal(saves(calls).length, 2, "the delayed save still runs");
});

// A pull or ack can apply a clear made elsewhere while a title save waits.
// The editor's notes are then stale: the save writes only the title, and the
// editor then shows the stored notes instead of bringing the cleared text back.
test("a title save after a pull or ack writes only the title, then shows the stored notes", async (t) => {
  const calls = await mountView(t, (id, updates) => ({
    success: true,
    note: { ...globalThis.__note, ...updates },
  }));

  await React.act(async () => globalThis.__editorProps.onTitleChange(NOTE.id, "Retitled"));
  globalThis.__note = { ...NOTE, content: "" };
  await calls.rerender();
  assert.equal(globalThis.__editorProps.note.content, "Notes", "a pending save keeps the draft");
  await React.act(() => settle(1100));
  assert.deepEqual(saves(calls), [["save", NOTE.id, { title: "Retitled" }]]);
  assert.equal(globalThis.__editorProps.note.content, "");
  assert.equal(globalThis.__editorProps.note.title, "Retitled");
});

test("a title edit after a notes edit still saves the notes", async (t) => {
  const calls = await mountView(t);

  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Typed"));
  await React.act(async () => globalThis.__editorProps.onTitleChange(NOTE.id, "Retitled"));
  await React.act(() => settle(1100));
  assert.deepEqual(saves(calls), [["save", NOTE.id, { title: "Retitled", content: "Typed" }]]);

  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, ""));
  await React.act(async () => globalThis.__editorProps.onTitleChange(NOTE.id, "Again"));
  await React.act(() => settle(1100));
  assert.deepEqual(saves(calls).at(-1), [
    "save",
    NOTE.id,
    { title: "Again", content: "", clear_fields: ["content"] },
  ]);
});
