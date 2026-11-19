const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

// The editor saves a second after typing stops. When the open note is deleted
// on another device (or with its folder) inside that second, the save is
// refused and what was typed would be gone: the editor saves it as a new note
// in Private instead, unless the note was deleted here. PersonalNotesView is
// real; NoteEditor is a stub that exposes the props it hands the editor.

const OWNER = "account-1";
const NOTE = {
  id: 11,
  title: "Standup",
  content: "Notes",
  enhanced_content: "Summary",
  transcript: "[transcript]",
  folder_id: 5,
  space_id: 1,
  note_type: "meeting",
};

const MOCKS = {
  "/ui/useToast": `
    const toast = (props) => { globalThis.__toasts.push(props); return "1"; };
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
  "/hooks/useNotesOnboarding": `
    export const useNotesOnboarding = () => ({ isComplete: true, complete() {} });
  `,
  "/hooks/useTeamSpacesCapability": `export const useTeamSpacesCapability = () => false;`,
  "/useAuth": `export const useAuth = () => ({ isLoaded: true, isSignedIn: false, user: null });`,
  "/stores/deviceNotesStore": `
    export const useDeviceNotesStore = (select) => select({ viewNoteId: null });
  `,
  "/stores/noteStore": `
    const note = () => globalThis.__note;
    const spaces = () => globalThis.__spaces;
    export const setActiveNoteId = () => {};
    export const useActiveNoteId = () => note()?.id ?? null;
    export const useActiveNote = () => note();
    export const useNotes = () => [];
    export const useSpaces = () => spaces();
    export const getSpacesValue = () => spaces();
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
    export const markNoteEdited = () => {};
    export const openNote = (copy) => globalThis.__opened.push(copy);
    export const wasNoteDeletedHere = (id) => globalThis.__deletedHere.has(id);
  `,
};

const PRIVATE = { id: 1, kind: "private", name: "Private" };
const TEAM = { id: 2, kind: "team", name: "Engineering" };

// `stored` is the row main holds for the note: null once it is gone.
async function mountView(t, { stored = null, accountId = OWNER } = {}) {
  const calls = [];
  const state = { stored, accountId, nextId: 500 };
  let root;
  globalThis.__note = NOTE;
  globalThis.__spaces = [PRIVATE, TEAM];
  globalThis.__toasts = [];
  globalThis.__opened = [];
  globalThis.__deletedHere = new Set();
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    for (const key of ["__editorProps", "__note", "__spaces", "__toasts", "__opened"]) {
      delete globalThis[key];
    }
    delete globalThis.__deletedHere;
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getNoteWriteGuard: async () => ({ accountId: state.accountId, authGeneration: 1 }),
        getNote: async (id) => (id === NOTE.id ? state.stored : null),
        updateNote: async (id, updates) => {
          calls.push(["update", id, updates]);
          if (id === NOTE.id) return { success: false, error: "Note not found" };
          return { success: true, note: { id, ...updates } };
        },
        saveNote: async (...args) => {
          calls.push(["save", ...args]);
          const [title, content, noteType, , , , spaceId, transcript] = args;
          const id = state.nextId++;
          return {
            success: true,
            note: { id, title, content, note_type: noteType, space_id: spaceId ?? 1, transcript },
          };
        },
        discardNoteUndo: async () => {},
      },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
    },
  });
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-personal-notes-lost-note-",
    mockModules: MOCKS,
  });
  const { default: PersonalNotesView } = await vite.ssrLoadModule(
    "/components/notes/PersonalNotesView.tsx"
  );
  root = createRoot(container);
  const render = () => React.act(async () => root.render(React.createElement(PersonalNotesView)));
  await render();
  // Lets the editor read whose note it opened.
  await React.act(() => settle(0));
  return { calls, state, render };
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const kind = (calls, name) => calls.filter(([entry]) => entry === name);

// The note store drops the deleted note, so the editor closes it and sends its pending save.
async function closeDeletedNote(view) {
  globalThis.__note = null;
  await view.render();
  await React.act(() => settle(20));
}

test("edits to a note deleted elsewhere before they saved go to a new note in Private", async (t) => {
  const view = await mountView(t);
  await React.act(async () => globalThis.__editorProps.onTitleChange(NOTE.id, "Standup notes"));
  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Typed just now"));

  await closeDeletedNote(view);

  const saves = kind(view.calls, "save");
  assert.equal(saves.length, 1, "one copy");
  const [, title, content, noteType, , , folderId, spaceId, transcript, guard] = saves[0];
  assert.equal(title, "Standup notes");
  assert.equal(content, "Typed just now");
  assert.equal(noteType, "meeting");
  assert.equal(folderId, null, "the Private's default folder, not the deleted one");
  assert.equal(spaceId, PRIVATE.id, "a Private note stays in its own Private");
  assert.equal(transcript, NOTE.transcript);
  assert.deepEqual(guard, { accountId: OWNER, authGeneration: 1 }, "main refuses another account");
  // The summary the editor showed comes along.
  assert.deepEqual(kind(view.calls, "update").at(-1), [
    "update",
    500,
    { enhanced_content: "Summary" },
  ]);

  assert.equal(globalThis.__toasts.length, 1);
  const [toast] = globalThis.__toasts;
  assert.match(toast.description, /Standup notes/);
  toast.actions[0].onClick();
  assert.equal(globalThis.__opened[0].id, 500, "Open goes to the copy");
});

test("a team note's edits go to the active workspace's Private", async (t) => {
  const view = await mountView(t);
  globalThis.__note = { ...NOTE, space_id: TEAM.id };
  await view.render();
  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Typed"));

  await closeDeletedNote(view);

  const [save] = kind(view.calls, "save");
  assert.equal(save[7], null, "main picks the Private");
});

test("a delayed save refused while the note is open makes one copy, and later edits follow it", async (t) => {
  const view = await mountView(t);
  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "First"));
  await React.act(() => settle(1100));
  assert.equal(kind(view.calls, "save").length, 1);

  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Second"));
  await React.act(() => settle(1100));

  assert.equal(kind(view.calls, "save").length, 1, "no second copy");
  assert.deepEqual(kind(view.calls, "update").at(-1), [
    "update",
    500,
    { title: NOTE.title, content: "Second" },
  ]);
  assert.equal(globalThis.__toasts.length, 1, "announced once");
});

test("a note deleted here with its folder takes its unsaved edits with it", async (t) => {
  const view = await mountView(t);
  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Typed"));
  globalThis.__deletedHere.add(NOTE.id);

  await closeDeletedNote(view);

  assert.equal(kind(view.calls, "save").length, 0);
  assert.equal(globalThis.__toasts.length, 0);
});

test("a save refused while the note is still there makes no copy", async (t) => {
  const view = await mountView(t, { stored: { ...NOTE, deleted_at: null } });
  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Typed"));

  await closeDeletedNote(view);

  assert.equal(kind(view.calls, "save").length, 0);
});

test("a deleted note's tombstone still gets its edits copied", async (t) => {
  const view = await mountView(t, { stored: { ...NOTE, deleted_at: "2026-11-19 10:00:00" } });
  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Typed"));

  await closeDeletedNote(view);

  assert.equal(kind(view.calls, "save").length, 1);
});

// A save is also refused once another account is signed in; its edits never go to that account.
test("no copy is made for an account other than the one that opened the note", async (t) => {
  const view = await mountView(t);
  await React.act(async () => globalThis.__editorProps.onContentChange(NOTE.id, "Typed"));
  view.state.accountId = "account-2";

  await closeDeletedNote(view);

  assert.equal(kind(view.calls, "save").length, 0);
  assert.equal(globalThis.__toasts.length, 0);
});
