const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

// Accepting an invitation to a workspace whose space never syncs here (one with
// no team space yet) left the invitation entry set for the life of the
// window, so every later visit to Notes reopened "Where your notes live".
//
// The shell below mirrors ControlPanel.tsx: the entry comes from the real
// useInvitationNotesEntry hook, and PersonalNotesView renders only while Notes
// is the active view. The dialog is a stub that records its open state.

const MOCKS = {
  "/ui/useToast": `
    const toast = () => "1";
    export const useToast = () => ({ toast, dismiss() {} });
  `,
  "/icons": `export const Plus = () => null; export const Sparkles = () => null;`,
  "./NoteEditor": `export default () => null;`,
  "./SpacesTree": `export default () => null;`,
  "/overview/ContainerOverview": `export const ContainerOverview = () => null;`,
  "./NotesStructureIntroDialog": `
    export default function NotesStructureIntroDialog({ open, onOpenChange }) {
      globalThis.__intro = { open, onOpenChange };
      return null;
    }`,
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
    import { useSyncExternalStore } from "react";
    const state = { activeNoteId: null };
    const subscribers = new Set();
    const subscribe = (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    };
    const note = { id: 11, title: "Note", content: "", transcript: "", folder_id: null, space_id: 1 };
    export const setActiveNoteId = (id) => {
      state.activeNoteId = id;
      subscribers.forEach((fn) => fn());
    };
    globalThis.__setActiveNoteId = setActiveNoteId;
    export const useActiveNoteId = () => useSyncExternalStore(subscribe, () => state.activeNoteId);
    export const useActiveNote = () =>
      useSyncExternalStore(subscribe, () => (state.activeNoteId === 11 ? note : null));
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
    export const getNoteFromStore = (id) => (id === 11 ? note : null);
  `,
};

const invitation = () => ({ workspaceId: "ws-empty", teamIds: [], spaceIds: [] });

async function setup(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    for (const key of ["__intro", "__setActiveNoteId"]) delete globalThis[key];
  });
  // This device has already seen the intro, so only the invitation can open it.
  installBrowserGlobals(t, {
    initialStorage: { notesStructureIntroVersion: "1" },
    window: { electronAPI: {}, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  const container = installHostDom(t);
  globalThis.document.visibilityState = "visible";
  globalThis.document.hasFocus = () => true;

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-structure-intro-invitation-test-",
    mockModules: MOCKS,
  });
  const { default: PersonalNotesView } = await vite.ssrLoadModule(
    "/components/notes/PersonalNotesView.tsx"
  );
  const { useInvitationNotesEntry } = await vite.ssrLoadModule("/hooks/useInvitationNotesEntry.ts");
  const { useMeetingRecordingStore } = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");

  const controls = {};
  const Shell = () => {
    const [view, setView] = React.useState("home");
    const [entry, setEntry] = useInvitationNotesEntry(view === "personal-notes");
    controls.setView = setView;
    controls.entry = entry;
    // AcceptInvitationModal's onAccepted, as ControlPanel wires it.
    controls.accept = (accepted) => {
      setEntry(accepted);
      setView("personal-notes");
    };
    return view === "personal-notes"
      ? React.createElement(PersonalNotesView, {
          invitationEntry: entry,
          onInvitationEntryHandled: () => setEntry(null),
        })
      : React.createElement("div", null, view);
  };
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Shell)));

  const act = (fn) => React.act(async () => fn());
  return {
    controls,
    accept: (entry) => act(() => controls.accept(entry)),
    show: (view) => act(() => controls.setView(view)),
    closeIntro: () => act(() => globalThis.__intro.onOpenChange(false)),
    introOpen: () => globalThis.__intro?.open === true,
    // A narrow window with a note open is the side-panel layout, which hides the intro.
    setSidePanelLayout: async (on) => {
      await act(() => useMeetingRecordingStore.setState({ windowWidth: on ? 400 : 1400 }));
      await act(() => globalThis.__setActiveNoteId(on ? 11 : null));
    },
  };
}

test("an invitation whose space never syncs shows the intro once, not on every Notes visit", async (t) => {
  const { controls, accept, show, closeIntro, introOpen } = await setup(t);

  await accept(invitation());
  assert.equal(introOpen(), true, "accepting shows the intro");
  await closeIntro();
  assert.equal(introOpen(), false);

  await show("home");
  assert.equal(controls.entry, null, "leaving Notes ends the invitation's visit");
  await show("personal-notes");
  assert.equal(introOpen(), false, "returning to Notes does not reopen the intro");
});

test("a layout change while the invited space is still syncing does not reopen the intro", async (t) => {
  const { accept, closeIntro, introOpen, setSidePanelLayout } = await setup(t);

  await accept(invitation());
  assert.equal(introOpen(), true);
  await closeIntro();

  await setSidePanelLayout(true);
  await setSidePanelLayout(false);
  assert.equal(introOpen(), false);
});

// Control: the guard is per invitation, so a later acceptance still shows it.
test("accepting another invitation shows the intro again", async (t) => {
  const { accept, show, closeIntro, introOpen } = await setup(t);

  await accept(invitation());
  await closeIntro();
  await show("home");

  await accept(invitation());
  assert.equal(introOpen(), true);
});
