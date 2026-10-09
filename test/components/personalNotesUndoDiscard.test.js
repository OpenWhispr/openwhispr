const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

// Typing in the open note retires the assistant's Undo at once, before the
// editor's delayed save: an Undo clicked in that second would restore the
// assistant's previous text over what the user just typed. PersonalNotesView
// is real; NoteEditor is a stub that exposes its props.

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

test("editing either document retires the assistant's Undo before the delayed save", async (t) => {
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
          return { success: true };
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
  await React.act(async () => root.render(React.createElement(PersonalNotesView)));

  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Typed"));
  assert.deepEqual(calls, [["discard", NOTE.id]], "retired before the save");
  await React.act(async () =>
    globalThis.__editorProps.enhancement.onChange(NOTE.id, "Typed summary")
  );
  assert.deepEqual(calls.at(-1), ["discard", NOTE.id]);
  assert.equal(calls.filter(([kind]) => kind === "save").length, 0);
});
