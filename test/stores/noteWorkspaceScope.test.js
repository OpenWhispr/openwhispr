const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Personal (1), a teamspace in workspace A (2) and one in workspace B (3).
const spaces = [
  { id: 1, kind: "private", workspace_id: null, name: "Personal" },
  { id: 2, kind: "team", workspace_id: "a", name: "Alpha" },
  { id: 3, kind: "team", workspace_id: "b", name: "Beta" },
];
const folders = [
  { id: 10, space_id: 1, name: "Personal", is_default: 1 },
  { id: 30, space_id: 3, name: "Beta docs", is_default: 0 },
];
const notes = [
  { id: 100, space_id: 1, folder_id: 10, title: "Personal note" },
  { id: 300, space_id: 3, folder_id: 30, title: "Beta note" },
];

async function fixture(t) {
  installBrowserGlobals(t, { initialStorage: { activeWorkspaceId: "a" } });
  globalThis.window.electronAPI = {
    getSpaces: async () => spaces,
    getFolders: async () => folders,
    getFolderNoteCounts: async () => [],
    getNotes: async (_type, _limit, folderId, spaceId) =>
      notes.filter((note) =>
        folderId != null
          ? note.folder_id === folderId
          : note.space_id === spaceId && note.folder_id == null
      ),
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
  const { useWorkspaceStore } = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  const store = await vite.ssrLoadModule("/stores/noteStore.ts");
  useWorkspaceStore.setState({
    workspaces: [
      { id: "a", name: "A", role: "member" },
      { id: "b", name: "B", role: "member" },
    ],
    loaded: true,
    activeWorkspaceId: "a",
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

test("switching workspaces keeps a Personal note open", async (t) => {
  const f = await fixture(t);
  await f.settle();
  f.store.setActiveNoteId(100);
  f.switchTo("b");
  assert.deepEqual(f.context(), { folderId: 10, noteId: 100 });
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

test("a switch closes a note that hadn't loaded, so its load can't pull the user back", async (t) => {
  const f = await fixture(t);
  f.switchTo("b");
  f.store.setActiveFolderId(30);
  await f.settle();
  f.store.setActiveNoteId(999);

  f.switchTo("a");
  assert.deepEqual(f.context(), { folderId: 10, noteId: null });
  f.store.addNote({ id: 999, space_id: 3, folder_id: 30, title: "Late" });
  assert.equal(f.activeWorkspaceId(), "a");
});

test("a workspace switch cancels a pending open, so its load closes it instead", async (t) => {
  const f = await fixture(t);
  await f.settle();
  // Opened from Personal before B's folder loaded, then the user switches
  // away and back.
  f.store.setActiveNoteId(300);
  f.switchTo("b");
  f.switchTo("a");
  await f.store.loadContainerNotes(f.store.folderContainerKey(30));
  assert.equal(f.activeWorkspaceId(), "a");
  assert.deepEqual(f.context(), { folderId: 10, noteId: null });
});
