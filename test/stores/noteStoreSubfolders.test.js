const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const folder = (id, name, parent_folder_id = null, is_default = 0) => ({
  id,
  name,
  is_default,
  space_id: 1,
  parent_folder_id,
});
const PERSONAL = folder(1, "Personal", null, 1);
const WORK = folder(11, "Work");
const Q1 = folder(12, "Q1", 11);
const note = (id, folder_id, space_id = 1) => ({ id, folder_id, space_id, title: `Note ${id}` });

// The real store over a fake main process that keeps the folder list. Like
// main, a delete answers first and then sends one folder-deleted event per
// folder, subfolders first; they land before the store's folder reload does.
async function loadStore(t) {
  const main = { folders: [PERSONAL, WORK, Q1], echoes: [], onFolderDeleted: null };
  const syncPushes = [];
  const { storage } = installBrowserGlobals(t, {
    window: {
      syncPushes,
      electronAPI: {
        getFolders: async () => {
          for (const id of main.echoes.splice(0)) main.onFolderDeleted({ id });
          return main.folders;
        },
        getFolderNoteCounts: async () => [],
        // Each folder holds one note, in the folder's current space.
        getNotes: async (_type, _limit, folderId) => {
          const home = main.folders.find((f) => f.id === folderId);
          return home ? [note(100 + folderId, folderId, home.space_id)] : [];
        },
        createFolder: async (name, space_id, parentFolderId) => {
          const created = { ...folder(13, name, parentFolderId), space_id };
          main.folders = [...main.folders, created];
          return { success: true, folder: created };
        },
        setFolderParent: async (id, parent_folder_id) => {
          main.folders = main.folders.map((f) => (f.id === id ? { ...f, parent_folder_id } : f));
          return { success: true };
        },
        moveFolderToSpace: async (id, space_id) => {
          main.folders = main.folders.map((f) =>
            f.id === id || f.parent_folder_id === id ? { ...f, space_id } : f
          );
          return { success: true };
        },
        deleteFolder: async (id) => {
          const subfolders = main.folders.filter((f) => f.parent_folder_id === id);
          main.echoes = [...subfolders.map((f) => f.id), id];
          main.folders = main.folders.filter((f) => !main.echoes.includes(f.id));
          return { success: true };
        },
        onFolderDeleted: (callback) => {
          main.onFolderDeleted = callback;
          return () => {};
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-store-subfolders-",
    mockModules: {
      "/services/SyncService.js": `export const syncService = {
        setNoteOpen() {},
        requestSyncAll() {},
        debouncedPush: (...args) => window.syncPushes.push(args),
      };`,
    },
  });
  const store = await vite.ssrLoadModule("/stores/noteStore.ts");
  await store.initializeNotes(null, 50, null);
  await store.loadFolders();
  await Promise.all(["f:1", "f:11", "f:12"].map((key) => store.loadContainerNotes(key)));
  const expanded = () => JSON.parse(storage.getItem("notesTree.expanded") ?? "[]").sort();
  return { main, store, expanded, syncPushes };
}

test("revealing a subfolder expands its parent folder too", async (t) => {
  const { store, expanded } = await loadStore(t);

  store.revealContainer(1, 12);

  assert.deepEqual(expanded(), ["f:11", "f:12", "s:1"]);
});

test("deleting the active subfolder falls back to its parent folder", async (t) => {
  const { store } = await loadStore(t);
  store.setActiveContext(1, 12);

  await store.deleteFolder(12);

  assert.equal(store.getActiveFolderIdValue(), 11);
  assert.equal(store.getNoteFromStore(112), null);
});

test("deleting a parent tears down its subfolders' containers too", async (t) => {
  const { store, expanded } = await loadStore(t);
  store.revealContainer(1, 12);
  store.setActiveContext(1, 12);

  await store.deleteFolder(11);

  assert.equal(store.getActiveFolderIdValue(), 1);
  assert.equal(store.getNoteFromStore(111), null);
  assert.equal(store.getNoteFromStore(112), null);
  assert.deepEqual(expanded(), ["s:1"]);
});

test("a subfolder deleted elsewhere moves the active view to its parent", async (t) => {
  const { main, store } = await loadStore(t);
  store.setActiveContext(1, 12);

  main.folders = [PERSONAL, WORK];
  main.onFolderDeleted({ id: 12 });

  assert.equal(store.getActiveFolderIdValue(), 11);
  assert.equal(store.getNoteFromStore(112), null);
});

test("a parent deleted elsewhere leaves its surviving subfolder open", async (t) => {
  const { main, store, expanded } = await loadStore(t);
  store.revealContainer(1, 12);
  store.setActiveContext(1, 12);
  store.setActiveNoteId(112);

  // Main's hard delete keeps the subfolder, now top level.
  main.folders = [PERSONAL, folder(12, "Q1")];
  main.onFolderDeleted({ id: 11 });

  assert.equal(store.getActiveFolderIdValue(), 12);
  assert.equal(store.getActiveNoteIdValue(), 112);
  assert.ok(store.getNoteFromStore(112));
  assert.deepEqual(expanded(), ["f:12", "s:1"]);
});

test("a parent and then its subfolder deleted elsewhere leave the view on the space root", async (t) => {
  const { main, store } = await loadStore(t);
  store.setActiveContext(1, 12);

  main.folders = [PERSONAL];
  main.onFolderDeleted({ id: 11 });
  main.onFolderDeleted({ id: 12 });

  assert.equal(store.getActiveFolderIdValue(), null);
});

test("creating a subfolder and moving it reload the folders and push the folder", async (t) => {
  const { store, syncPushes } = await loadStore(t);

  await store.createFolder("Q2", 1, 11);
  await store.setFolderParent(12, null);

  assert.deepEqual(
    store.getFoldersValue().map((f) => [f.id, f.parent_folder_id]),
    [
      [1, null],
      [11, null],
      [12, null],
      [13, 11],
    ]
  );
  assert.deepEqual(syncPushes, [
    ["folder", 13],
    ["folder", 12],
  ]);
});

test("moving a parent to another space refreshes its subfolder's loaded notes", async (t) => {
  const { store } = await loadStore(t);

  await store.moveFolderToSpace(11, 2);

  assert.equal(store.getNoteFromStore(111).space_id, 2);
  assert.equal(store.getNoteFromStore(112).space_id, 2);
  assert.equal(store.getNoteFromStore(101).space_id, 1);
});

test("moving a parent to another space takes an open subfolder's view along", async (t) => {
  const { store } = await loadStore(t);
  store.setActiveContext(1, 12);
  // The open container's space is only readable through the store's hook.
  let context;
  function ActiveContext() {
    context = store.useActiveContext();
    return null;
  }
  const root = createRoot(installHookDom(t));
  await React.act(async () => root.render(React.createElement(ActiveContext)));

  await React.act(() => store.moveFolderToSpace(11, 2));
  await React.act(async () => root.unmount());

  assert.deepEqual(context, { spaceId: 2, folderId: 12 });
});
