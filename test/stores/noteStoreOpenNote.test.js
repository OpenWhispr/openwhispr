const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Personal's default folder holds three notes, but a container loads only its
// newest page: here the two newest. Note 103 sits past it.
const spaces = [{ id: 1, kind: "private", workspace_id: null, name: "Personal" }];
const folders = [{ id: 10, space_id: 1, name: "Personal", is_default: 1 }];
const notes = [
  { id: 101, space_id: 1, folder_id: 10, title: "Newest", deleted_at: null },
  { id: 102, space_id: 1, folder_id: 10, title: "Newer", deleted_at: null },
  { id: 103, space_id: 1, folder_id: 10, title: "Q3 planning sync", deleted_at: null },
  { id: 104, space_id: 1, folder_id: 10, title: "Trashed", deleted_at: "2026-10-29T10:00:00Z" },
];
const PAGE = 2;

async function fixture(t) {
  const getNoteCalls = [];
  installBrowserGlobals(t);
  globalThis.window.electronAPI = {
    getSpaces: async () => spaces,
    getFolders: async () => folders,
    getFolderNoteCounts: async () => [],
    getNotes: async (_type, _limit, folderId) =>
      notes.filter((note) => note.folder_id === folderId && !note.deleted_at).slice(0, PAGE),
    getNote: async (id) => {
      getNoteCalls.push(id);
      return notes.find((note) => note.id === id) ?? null;
    },
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-store-open-note-",
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
  const store = await vite.ssrLoadModule("/stores/noteStore.ts");
  await store.initializeNotesTree();
  return { store, getNoteCalls };
}

test("opening a note past its folder's loaded page adds it to the folder", async (t) => {
  const { store } = await fixture(t);
  assert.equal(store.getNoteFromStore(103), null);

  store.setActiveNoteId(103);
  await store.ensureNoteLoaded(103);
  assert.equal(store.getNoteFromStore(103)?.title, "Q3 planning sync");
  assert.equal(store.getActiveNoteIdValue(), 103);
});

test("reloading the folder keeps the open note", async (t) => {
  const { store } = await fixture(t);
  store.setActiveNoteId(103);
  await store.ensureNoteLoaded(103);

  await store.loadContainerNotes(store.folderContainerKey(10));
  assert.equal(store.getNoteFromStore(103)?.title, "Q3 planning sync");

  // Once another note is open, a reload drops the one past the page again.
  store.setActiveNoteId(101);
  await store.loadContainerNotes(store.folderContainerKey(10));
  assert.equal(store.getNoteFromStore(103), null);
});

test("a loaded note isn't fetched, and a trashed one isn't added", async (t) => {
  const { store, getNoteCalls } = await fixture(t);

  await store.ensureNoteLoaded(101);
  assert.deepEqual(getNoteCalls, []);

  await store.ensureNoteLoaded(104);
  assert.equal(store.getNoteFromStore(104), null);
});

function deferred() {
  const { promise, resolve } = Promise.withResolvers();
  return { promise, resolve };
}

test("account reset cancels an outstanding note lookup", async (t) => {
  const { store } = await fixture(t);
  const lookup = deferred();
  globalThis.window.electronAPI.getNote = () => lookup.promise;
  const opening = store.ensureNoteLoaded(103);
  store.resetForAccountChange();
  lookup.resolve(notes[2]);
  await opening;
  assert.equal(store.getNoteFromStore(103), null);
});

test("account reset cancels a note waiting for its container", async (t) => {
  const { store } = await fixture(t);
  const container = deferred();
  const started = deferred();
  globalThis.window.electronAPI.getNote = async () => ({ ...notes[2], folder_id: 20 });
  globalThis.window.electronAPI.getNotes = () => {
    started.resolve();
    return container.promise;
  };
  const opening = store.ensureNoteLoaded(103);
  await started.promise;
  store.resetForAccountChange();
  container.resolve([]);
  await opening;
  assert.equal(store.getNoteFromStore(103), null);
});

test("reloading refreshes an older open note after its folder changes space", async (t) => {
  const { store } = await fixture(t);
  store.setActiveNoteId(103);
  await store.ensureNoteLoaded(103);
  globalThis.window.electronAPI.getNote = async () => ({ ...notes[2], space_id: 2 });
  await store.loadContainerNotes(store.folderContainerKey(10));
  assert.equal(store.getNoteFromStore(103)?.space_id, 2);
});

for (const [name, refreshed] of [
  ["missing", null],
  ["deleted", { ...notes[2], deleted_at: "2026-11-02T10:00:00Z" }],
  ["moved to another container", { ...notes[2], folder_id: 20 }],
]) {
  test(`reloading drops an older open note that is ${name}`, async (t) => {
    const { store } = await fixture(t);
    store.setActiveNoteId(103);
    await store.ensureNoteLoaded(103);
    globalThis.window.electronAPI.getNote = async () => refreshed;
    await store.loadContainerNotes(store.folderContainerKey(10));
    assert.equal(store.getNoteFromStore(103), null);
  });
}

for (const mutation of ["update", "delete", "account reset", "newer load"]) {
  test(`an older note refresh cannot overwrite ${mutation}`, async (t) => {
    const { store } = await fixture(t);
    store.setActiveNoteId(103);
    await store.ensureNoteLoaded(103);
    const lookup = deferred();
    const started = deferred();
    globalThis.window.electronAPI.getNote = () => {
      started.resolve();
      return lookup.promise;
    };
    const loading = store.loadContainerNotes(store.folderContainerKey(10));
    await started.promise;
    const updated = { ...notes[2], title: "Newer update" };
    if (mutation === "update") store.updateNoteInStore(updated);
    if (mutation === "delete") store.removeNote(103);
    if (mutation === "account reset") store.resetForAccountChange();
    if (mutation === "newer load") {
      globalThis.window.electronAPI.getNotes = async () => [notes[0], updated];
      await store.loadContainerNotes(store.folderContainerKey(10));
    }
    lookup.resolve({ ...notes[2], title: "Stale lookup" });
    await loading;
    assert.equal(
      store.getNoteFromStore(103)?.title ?? null,
      mutation === "update" || mutation === "newer load" ? "Newer update" : null
    );
  });
}
