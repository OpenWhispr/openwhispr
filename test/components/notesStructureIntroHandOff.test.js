const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

// After accepting an invitation or joining a workspace, ControlPanel holds the workspace intro
// until Notes takes over: by then Notes' structure intro is open or holds its own gate.

const MOCKS = {
  "/ui/useToast": `
    const toast = () => "1";
    export const useToast = () => ({ toast, dismiss() {} });
  `,
  "/icons": `export const Plus = () => null; export const Sparkles = () => null;`,
  "./NoteEditor": `export default () => null;`,
  "./SpacesTree": `export default () => null;`,
  "/overview/ContainerOverview": `export const ContainerOverview = () => null;`,
  // Holds the gate while open, as the real dialog does, and hands the test its props.
  "./NotesStructureIntroDialog": `
    import { useLayoutEffect } from "react";
    export default function NotesStructureIntroDialog(props) {
      globalThis.__structureIntro = props;
      useLayoutEffect(() => {
        if (!props.open) return;
        const { setModalOpen } = globalThis.__gateStore.getState();
        setModalOpen("notesStructureIntro", true);
        return () => setModalOpen("notesStructureIntro", false);
      }, [props.open]);
      return null;
    }
  `,
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
  "/hooks/useAuth": `export const useAuth = () => ({ isSignedIn: true, user: { id: "user-1" } });`,
  "/stores/noteStore": `
    export const setActiveNoteId = () => {};
    export const useActiveNoteId = () => globalThis.__activeNoteId;
    export const useActiveNote = () => null;
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
    export const getNoteFromStore = () => null;
  `,
};

const ENTRY = { workspaceId: "beta", teamIds: ["team-1"], spaceIds: [] };

async function setup(t) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__structureIntro;
    delete globalThis.__gateStore;
    delete globalThis.__activeNoteId;
  });
  globalThis.__activeNoteId = null;
  // useTeamSpacesCapability is false, so the intro is never due on its own: only an
  // invitation opens it.
  installBrowserGlobals(t, {
    window: { electronAPI: {}, setTimeout: (fn, ms) => setTimeout(fn, ms) },
  });
  const container = installHostDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-notes-structure-intro-hand-off-",
    mockModules: MOCKS,
  });
  const { useModalGateStore, useModalGate } = await vite.ssrLoadModule("/stores/modalGateStore.ts");
  globalThis.__gateStore = useModalGateStore;
  const { useMeetingRecordingStore } = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { default: PersonalNotesView } = await vite.ssrLoadModule(
    "/components/notes/PersonalNotesView.tsx"
  );

  // ControlPanel's side of the hand-off.
  let finishes = 0;
  function Host({ entry, handOff }) {
    const [notesHandOff, setNotesHandOff] = React.useState(handOff);
    const finish = React.useCallback(() => {
      finishes++;
      setNotesHandOff(false);
    }, []);
    useModalGate("notesHandOff", notesHandOff);
    return React.createElement(PersonalNotesView, {
      invitationEntry: entry,
      notesHandOff,
      onNotesHandOffDone: finish,
    });
  }

  root = createRoot(container);
  const render = (props) => React.act(async () => root.render(React.createElement(Host, props)));
  const gates = () => Object.keys(useModalGateStore.getState().open).sort();
  const setNarrowWithNote = (narrow) =>
    React.act(async () => {
      globalThis.__activeNoteId = narrow ? 11 : null;
      useMeetingRecordingStore.setState({ windowWidth: narrow ? 400 : 1400 });
    });
  return { render, gates, setNarrowWithNote, finishes: () => finishes };
}

test("an accepted invitation hands the gate to the structure intro it opens", async (t) => {
  const { render, gates, finishes } = await setup(t);

  await render({ entry: ENTRY, handOff: true });

  assert.equal(finishes(), 1);
  assert.equal(globalThis.__structureIntro.open, true);
  assert.deepEqual(gates(), ["notesStructureIntro"]);
});

test("a join with no intro to show releases the gate once Notes has mounted", async (t) => {
  const { render, gates, finishes } = await setup(t);

  await render({ entry: null, handOff: true });

  assert.equal(finishes(), 1);
  assert.equal(globalThis.__structureIntro.open, false);
  assert.deepEqual(gates(), []);
});

test("an invitation accepted in the side panel holds the gate until its intro can open", async (t) => {
  const { render, gates, setNarrowWithNote } = await setup(t);
  await setNarrowWithNote(true);

  await render({ entry: ENTRY, handOff: true });
  assert.equal(globalThis.__structureIntro.open, false);
  assert.deepEqual(gates(), []);

  await setNarrowWithNote(false);
  assert.equal(globalThis.__structureIntro.open, true);
  assert.deepEqual(gates(), ["notesStructureIntro"]);

  // Closing it releases the gate although the invited space never synced, and the intro
  // doesn't come back each time the side panel closes.
  await React.act(async () => globalThis.__structureIntro.onOpenChange(false));
  assert.deepEqual(gates(), []);
  await setNarrowWithNote(true);
  await setNarrowWithNote(false);
  assert.equal(globalThis.__structureIntro.open, false);
  assert.deepEqual(gates(), []);
});
