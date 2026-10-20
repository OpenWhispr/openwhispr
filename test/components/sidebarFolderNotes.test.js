const test = require("node:test");
const assert = require("node:assert/strict");
const { sidebarFolderNotes } = require("../../src/components/notes/sidebarFolderNotes.ts");
const notes = Array.from({ length: 17 }, (_, index) => ({ id: index + 1, folder_id: 7 }));

test("small folders keep every note and have no hidden count", () => {
  for (const count of [0, 1, 5]) {
    const shown = sidebarFolderNotes(notes.slice(0, count), null, 7);
    assert.equal(shown.length, count);
    assert.equal(count - shown.length, 0);
  }
});
test("long folders show five newest notes and count the remainder", () => {
  const shown = sidebarFolderNotes(notes, null, 7);
  assert.deepEqual(
    shown.map((note) => note.id),
    [1, 2, 3, 4, 5]
  );
  assert.equal(notes.length - shown.length, 12);
});
test("an older active note stays sixth, including outside the loaded page", () => {
  const active = { id: 100, folder_id: 7 };
  const shown = sidebarFolderNotes(notes, active, 7);
  assert.deepEqual(
    shown.map((note) => note.id),
    [1, 2, 3, 4, 5, 100]
  );
  assert.equal(101 - shown.length, 95);
  assert.equal(notes.length, 17);
});
test("active notes in the top five or another folder are not duplicated or pinned", () => {
  assert.equal(sidebarFolderNotes(notes, notes[1], 7).length, 5);
  assert.equal(sidebarFolderNotes(notes, { id: 100, folder_id: 8 }, 7).length, 5);
});

test("loading the full folder makes an older note available to the editor's shared store", async (t) => {
  const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
  const allNotes = Array.from({ length: 57 }, (_, index) => ({
    id: index + 1,
    folder_id: 7,
    space_id: 1,
    title: `Note ${index + 1}`,
  }));
  const calls = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getNotes: async (type, limit, folderId) => {
          calls.push({ type, limit, folderId });
          return limit < 0 ? allNotes : allNotes.slice(0, limit);
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-folder-overflow-store-",
    mockModules: {
      "/services/SyncService.js": "export const syncService = { setNoteOpen() {} };",
    },
  });
  const store = await vite.ssrLoadModule("/stores/noteStore.ts");
  await store.loadContainerNotes("f:7");
  assert.equal(store.getNoteFromStore(57), null);
  await store.loadContainerNotes("f:7", null, -1);
  store.setActiveNoteId(57);
  assert.equal(store.getNoteFromStore(57)?.id, 57);
  assert.deepEqual(calls.at(-1), { type: null, limit: -1, folderId: 7 });
});
