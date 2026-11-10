const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Workspace A (the default) and B each have their own Private (1 and 4) and a
// teamspace (2 and 3). Workspace C has no Private on this device yet.
const spaces = [
  { id: 1, kind: "private", workspace_id: "a", name: "Personal" },
  { id: 2, kind: "team", workspace_id: "a", name: "Alpha" },
  { id: 3, kind: "team", workspace_id: "b", name: "Beta" },
  { id: 4, kind: "private", workspace_id: "b", name: "Personal" },
];
const folders = [
  { id: 10, space_id: 1, name: "Personal", is_default: 1 },
  { id: 11, space_id: 1, name: "Ideas", is_default: 0 },
  { id: 30, space_id: 3, name: "Beta docs", is_default: 0 },
  { id: 40, space_id: 4, name: "Personal", is_default: 1 },
];
const notes = [
  { id: 100, space_id: 1, folder_id: 10, title: "Personal note" },
  { id: 110, space_id: 1, folder_id: 11, title: "Idea" },
  { id: 300, space_id: 3, folder_id: 30, title: "Beta note" },
  { id: 400, space_id: 4, folder_id: 40, title: "B private note" },
];

async function fixture(t, { workspaceState = {} } = {}) {
  const liveSpaces = [...spaces];
  const liveFolders = [...folders];
  installBrowserGlobals(t, { initialStorage: { activeWorkspaceId: "a" } });
  globalThis.window.electronAPI = {
    getSpaces: async () => [...liveSpaces],
    getFolders: async () => [...liveFolders],
    getFolderNoteCounts: async () => [],
    getNotes: async (_type, _limit, folderId, spaceId) =>
      notes.filter((note) =>
        folderId != null
          ? note.folder_id === folderId
          : note.space_id === spaceId && note.folder_id == null
      ),
    setActiveWorkspaceScope: async () => ({ success: true }),
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-workspace-scope-",
    mockModules: {
      "/services/SyncService.js": "export const syncService = { setNoteOpen() {} };",
      "/services/WorkspacesService": "export const WorkspacesService = { list: async () => [] };",
      "/policyStore": `
        export const usePolicyStore = {
          getState: () => ({ accountId: null, authGeneration: null }),
          subscribe: () => () => {},
        };
      `,
      "/enterpriseIdentityStore": `
        export const useEnterpriseIdentityStore = {
          getState: () => ({ clear() {}, refresh() {} }),
        };
      `,
    },
  });
  const workspaceStore = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  const { useWorkspaceStore } = workspaceStore;
  const store = await vite.ssrLoadModule("/stores/noteStore.ts");
  useWorkspaceStore.setState({
    workspaces: [
      { id: "a", name: "A", role: "member", is_default: true },
      { id: "b", name: "B", role: "member", is_default: false },
      { id: "c", name: "C", role: "member", is_default: false },
    ],
    loaded: true,
    activeWorkspaceId: "a",
    defaultWorkspaceId: "a",
    listAccountId: "account-1",
    ...workspaceState,
  });
  await store.initializeNotesTree();
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise(setImmediate);
  };
  return {
    store,
    settle,
    activeWorkspaceId: () => useWorkspaceStore.getState().activeWorkspaceId,
    switchTo: (id) => useWorkspaceStore.getState().setActiveWorkspaceId(id),
    // What the scope bridge does after every switch: main hears the workspace.
    publishScope: () => workspaceStore.publishWorkspaceScope(),
    putSpace: (space) => {
      const index = liveSpaces.findIndex((s) => s.id === space.id);
      if (index === -1) liveSpaces.push(space);
      else liveSpaces[index] = space;
    },
    putFolder: (folder) => liveFolders.push(folder),
    context: () => ({
      folderId: store.getActiveFolderIdValue(),
      noteId: store.getActiveNoteIdValue(),
    }),
  };
}

test("switching workspaces closes the note and container the switch hid", async (t) => {
  const f = await fixture(t);
  f.switchTo("b");
  f.store.setActiveFolderId(30);
  await f.settle();
  f.store.setActiveNoteId(300);
  assert.deepEqual(f.context(), { folderId: 30, noteId: 300 });

  f.switchTo("a");
  assert.deepEqual(f.context(), { folderId: 10, noteId: null });
  assert.equal(f.activeWorkspaceId(), "a");
});

test("switching workspaces lands on that workspace's own Private", async (t) => {
  const f = await fixture(t);
  await f.settle();
  f.store.setActiveNoteId(100);
  f.switchTo("b");
  // A's private note stays in A.
  assert.deepEqual(f.context(), { folderId: 40, noteId: null });
  f.switchTo("a");
  assert.deepEqual(f.context(), { folderId: 10, noteId: null });
});

test("opening a private note of another workspace enters that workspace", async (t) => {
  const f = await fixture(t);
  await f.settle();
  // A notification or a link opens B's private note before its folder loads.
  f.store.setActiveNoteId(400);
  assert.equal(f.activeWorkspaceId(), "a");
  await f.store.loadContainerNotes(f.store.folderContainerKey(40));
  assert.equal(f.activeWorkspaceId(), "b");
  assert.equal(f.context().noteId, 400);

  // Search picks B's private folder from A: folder first, then the note.
  f.switchTo("a");
  await f.settle();
  f.store.setActiveFolderId(40);
  assert.equal(f.activeWorkspaceId(), "b");
  f.store.setActiveNoteId(400);
  assert.deepEqual(f.context(), { folderId: 40, noteId: 400 });
});

test("a workspace without a Private yet lands on it once main makes it", async (t) => {
  const f = await fixture(t);
  await f.settle();
  f.store.setActiveNoteId(100);
  f.switchTo("c");
  // Nothing of A's Private stays open while C's is on its way.
  assert.deepEqual(f.context(), { folderId: null, noteId: null });

  // Main makes C's Private when it next reads the spaces after hearing the workspace.
  f.putSpace({ id: 5, kind: "private", workspace_id: "c", name: "Personal" });
  f.putFolder({ id: 50, space_id: 5, name: "Personal", is_default: 1 });
  assert.equal(await f.publishScope(), true);
  await f.settle();
  assert.deepEqual(f.context(), { folderId: 50, noteId: null });
  assert.equal(f.activeWorkspaceId(), "c");
});

test("a Private that arrives after the user went elsewhere doesn't move them", async (t) => {
  const f = await fixture(t);
  await f.settle();
  f.switchTo("c");
  // The user picks something else in C before its Private arrives.
  f.putSpace({ id: 6, kind: "team", workspace_id: "c", name: "Gamma" });
  await f.store.loadSpaces();
  f.store.setActiveContext(6, null);

  f.putSpace({ id: 5, kind: "private", workspace_id: "c", name: "Personal" });
  f.putFolder({ id: 51, space_id: 5, name: "Personal", is_default: 1 });
  await f.publishScope();
  await f.settle();
  // Still on Gamma's root, not the Private's default folder.
  assert.deepEqual(f.context(), { folderId: null, noteId: null });
  assert.equal(
    f.store.getSpacesValue().some((s) => s.id === 5),
    true
  );
});

test("before the workspace list answers, the saved workspace's own Private opens", async (t) => {
  // A launch: the active workspace comes from storage, the list and the default don't yet.
  const f = await fixture(t, {
    workspaceState: {
      workspaces: [],
      loaded: false,
      activeWorkspaceId: "b",
      defaultWorkspaceId: null,
      listAccountId: null,
    },
  });
  await f.settle();
  // B's Private, not the first Private main returned (A's).
  assert.deepEqual(f.context(), { folderId: 40, noteId: 400 });
});

test("opening another workspace's folder or note switches to that workspace", async (t) => {
  const f = await fixture(t);
  await f.settle();
  f.store.setActiveNoteId(100);
  // CommandSearch picks a result: folder first, then the note.
  f.store.setActiveFolderId(30);
  assert.equal(f.activeWorkspaceId(), "b");
  await f.settle();
  f.store.setActiveNoteId(300);
  assert.deepEqual(f.context(), { folderId: 30, noteId: 300 });
  assert.equal(f.activeWorkspaceId(), "b");
});

test("opening another workspace's note before it loads switches once it loads", async (t) => {
  const f = await fixture(t);
  await f.settle();
  f.store.setActiveNoteId(300);
  assert.equal(f.activeWorkspaceId(), "a");
  await f.store.loadContainerNotes(f.store.folderContainerKey(30));
  assert.equal(f.activeWorkspaceId(), "b");
  assert.equal(f.context().noteId, 300);
});

test("the open note moving into another workspace closes it without switching", async (t) => {
  const f = await fixture(t);
  // B's folder loaded earlier in the session.
  f.switchTo("b");
  f.store.setActiveFolderId(30);
  await f.settle();
  f.switchTo("a");
  await f.settle();
  f.store.setActiveNoteId(100);

  // A sync (or an undone move) puts the note into B's teamspace.
  f.store.updateNoteInStore({ ...f.store.getNoteFromStore(100), space_id: 3, folder_id: 30 });
  assert.equal(f.activeWorkspaceId(), "a");
  assert.deepEqual(f.context(), { folderId: 10, noteId: null });
});

test("a note that hadn't loaded when the user switched can't pull them back", async (t) => {
  const f = await fixture(t);
  f.switchTo("b");
  f.store.setActiveFolderId(30);
  await f.settle();
  f.store.setActiveNoteId(999);

  f.switchTo("a");
  f.store.addNote({ id: 999, space_id: 3, folder_id: 30, title: "Late" });
  assert.equal(f.activeWorkspaceId(), "a");
  assert.deepEqual(f.context(), { folderId: 10, noteId: null });
});

test("a switch keeps a private note of the new workspace that hadn't loaded open", async (t) => {
  const f = await fixture(t);
  f.switchTo("b");
  f.store.setActiveFolderId(30);
  await f.settle();
  // An upload or a chat link opens the note without moving the container.
  f.store.setActiveNoteId(110);

  f.switchTo("a");
  await f.store.loadContainerNotes(f.store.folderContainerKey(11));
  assert.equal(f.context().noteId, 110);
  assert.equal(f.activeWorkspaceId(), "a");
});

test("opening a space before it loads switches to its workspace once it arrives", async (t) => {
  const f = await fixture(t);
  await f.settle();
  // A teamspace just created in B: the dialog opens it before the reload
  // that brings it into the store.
  f.putSpace({ id: 7, kind: "team", workspace_id: "b", name: "New in B" });
  f.store.setActiveContext(7, null);
  assert.equal(f.activeWorkspaceId(), "a");

  await f.store.loadSpaces();
  assert.equal(f.activeWorkspaceId(), "b");
  // On the new space's root, not the Private's default folder.
  assert.equal(f.context().folderId, null);
});

test("an open space moving into another workspace leaves it without switching", async (t) => {
  const f = await fixture(t);
  await f.settle();
  f.store.setActiveContext(2, null);
  await f.settle();

  // Alpha, already loaded and open, turns out to belong to B after a sync.
  f.putSpace({ ...spaces[1], workspace_id: "b" });
  await f.store.loadSpaces();
  assert.equal(f.activeWorkspaceId(), "a");
  assert.equal(f.context().folderId, 10);
});

test("a workspace switch cancels a pending open, so its load closes it instead", async (t) => {
  const f = await fixture(t);
  await f.settle();
  // Opened from A before B's folder loaded, then the user switches
  // away and back.
  f.store.setActiveNoteId(300);
  f.switchTo("b");
  f.switchTo("a");
  await f.store.loadContainerNotes(f.store.folderContainerKey(30));
  assert.equal(f.activeWorkspaceId(), "a");
  assert.deepEqual(f.context(), { folderId: 10, noteId: null });
});
