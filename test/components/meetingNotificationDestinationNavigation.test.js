const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
async function fixture(t) {
  installBrowserGlobals(t);
  const calls = [];
  const row = { id: 9, space_id: 2, folder_id: null, title: "Root meeting", note_type: "meeting" };
  let release;
  globalThis.window.electronAPI = {
    getSpaces: async () => [
      { id: 1, kind: "private" },
      { id: 2, kind: "team" },
    ],
    getFolders: async () => [],
    getFolderNoteCounts: async () => [],
    getNotes: async () => [],
    getContainerNotes: async () => [],
    getNote: async () => row,
    confirmMeetingNoteNavigation: async (id, status) => {
      calls.push(["confirm", id, status]);
      return { success: true, value: row };
    },
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "meeting-navigation-",
    mockModules: { "/services/SyncService.js": "export const syncService={setNoteOpen(){}};" },
  });
  const store = await vite.ssrLoadModule("/stores/noteStore.ts");
  const { navigateMeetingNotification, navigateMeetingNote, navigateAndLoadMeetingNote } =
    await vite.ssrLoadModule("/components/meetingNotificationNavigation.ts");
  const prepare = () => new Promise((r) => (release = r));
  return {
    row,
    calls,
    store,
    navigateMeetingNote,
    navigateAndLoadMeetingNote,
    run: (isCurrent = () => true) =>
      navigateMeetingNotification(
        { navigationId: "nav", noteId: 9, spaceId: 2, folderId: null },
        isCurrent,
        prepare,
        (note) => calls.push(["record", note])
      ),
    release: () => release(),
  };
}
test("root navigation waits for editor loading then records the freshly confirmed row", async (t) => {
  const f = await fixture(t);
  const pending = f.run();
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, []);
  f.release();
  await pending;
  assert.equal(f.store.getActiveNoteIdValue(), 9);
  assert.equal(f.store.getActiveFolderIdValue(), null);
  assert.deepEqual(f.calls, [
    ["confirm", "nav", "ready"],
    ["record", f.row],
  ]);
});
test("unmount/account change during delayed editor loading cancels without recording", async (t) => {
  const f = await fixture(t);
  let current = true;
  const pending = f.run(() => current);
  await new Promise(setImmediate);
  current = false;
  f.release();
  await pending;
  assert.deepEqual(f.calls, [["confirm", "nav", "cancel"]]);
  assert.equal(f.store.getActiveNoteIdValue(), null);
});
test("failed live-note confirmation does not use a cached note to start", async (t) => {
  const f = await fixture(t);
  globalThis.window.electronAPI.confirmMeetingNoteNavigation = async () => ({
    success: false,
    code: "NOTE_UNAVAILABLE",
  });
  const pending = f.run();
  await new Promise(setImmediate);
  f.release();
  await pending;
  assert.deepEqual(f.calls, []);
  assert.equal(f.store.getActiveNoteIdValue(), null);
});

test("manual root meeting navigation leaves the previously selected folder", async (t) => {
  const f = await fixture(t);
  globalThis.window.electronAPI.getFolders = async () => [
    { id: 10, space_id: 1, name: "Personal", is_default: 1 },
  ];
  await f.store.initializeNotesTree();
  f.store.setActiveFolderId(10);
  assert.equal(f.store.getActiveFolderIdValue(), 10);

  f.navigateMeetingNote(9, 1, null);

  assert.equal(f.store.getActiveFolderIdValue(), null);
  assert.equal(f.store.getActiveNoteIdValue(), 9);
});

test("manual root meetings refresh a cached root without loading other containers", async (t) => {
  const f = await fixture(t);
  const rows = [
    { id: 8, space_id: 1, folder_id: null, title: "Earlier root note" },
    { id: 20, space_id: 2, folder_id: 20, title: "Team note" },
  ];
  const loads = [];
  globalThis.window.electronAPI.getFolders = async () => [
    { id: 10, space_id: 1, name: "Personal", is_default: 1 },
    { id: 20, space_id: 2, name: "Team", is_default: 0 },
  ];
  globalThis.window.electronAPI.getNotes = async (_type, _limit, folderId, spaceId) => {
    loads.push([folderId, spaceId]);
    return rows.filter((note) =>
      folderId != null
        ? note.folder_id === folderId
        : spaceId != null
          ? note.space_id === spaceId && note.folder_id == null
          : true
    );
  };
  await f.store.initializeNotesTree();
  await f.store.loadContainerNotes(f.store.spaceContainerKey(1));
  f.store.setActiveFolderId(20);
  await f.store.ensureContainerLoaded(f.store.folderContainerKey(20));
  assert.equal(f.store.getActiveFolderIdValue(), 20);
  loads.length = 0;
  rows.push({ ...f.row, space_id: 1, content: "Fresh meeting" });

  const loaded = await f.navigateAndLoadMeetingNote(9, 1, null);

  assert.deepEqual(
    loaded.map((note) => note.id),
    [8, 9]
  );
  assert.deepEqual(loads, [[null, 1]], "the selected root is refreshed exactly once");
  assert.deepEqual(
    (await f.store.ensureContainerLoaded(f.store.spaceContainerKey(1))).map((note) => note.id),
    [8, 9]
  );
  assert.equal(f.store.getActiveFolderIdValue(), null);
  assert.equal(f.store.getActiveNoteIdValue(), 9);
  assert.equal(f.store.getNoteFromStore(9).content, "Fresh meeting");
});
