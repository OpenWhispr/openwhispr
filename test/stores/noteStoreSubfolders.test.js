const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

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
const note = (id, folder_id) => ({ id, folder_id, space_id: 1, title: `Note ${id}` });
const NOTES = { 1: [note(101, 1)], 11: [note(111, 11)], 12: [note(112, 12)] };

// The real store over a fake main process whose folder list the test edits,
// as main's own delete would.
async function loadStore(t) {
  const main = { folders: [PERSONAL, WORK, Q1], onFolderDeleted: null };
  const { storage } = installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getFolders: async () => main.folders,
        getFolderNoteCounts: async () => [],
        getNotes: async (_type, _limit, folderId) => NOTES[folderId] ?? [],
        deleteFolder: async () => ({ success: true }),
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
      "/services/SyncService.js":
        "export const syncService = { setNoteOpen() {}, requestSyncAll() {} };",
    },
  });
  const store = await vite.ssrLoadModule("/stores/noteStore.ts");
  await store.initializeNotes(null, 50, null);
  await store.loadFolders();
  await Promise.all(["f:1", "f:11", "f:12"].map((key) => store.loadContainerNotes(key)));
  const expanded = () => JSON.parse(storage.getItem("notesTree.expanded") ?? "[]").sort();
  return { main, store, expanded };
}

test("revealing a subfolder expands its parent folder too", async (t) => {
  const { store, expanded } = await loadStore(t);

  store.revealContainer(1, 12);

  assert.deepEqual(expanded(), ["f:11", "f:12", "s:1"]);
});

test("deleting the active subfolder falls back to its parent folder", async (t) => {
  const { main, store } = await loadStore(t);
  store.setActiveContext(1, 12);

  main.folders = [PERSONAL, WORK];
  await store.deleteFolder(12);

  assert.equal(store.getActiveFolderIdValue(), 11);
  assert.equal(store.getNoteFromStore(112), null);
});

test("deleting a parent tears down its subfolders' containers too", async (t) => {
  const { main, store, expanded } = await loadStore(t);
  store.revealContainer(1, 12);
  store.setActiveContext(1, 12);

  main.folders = [PERSONAL];
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
