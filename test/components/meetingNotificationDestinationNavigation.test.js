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
  const { navigateMeetingNotification } = await vite.ssrLoadModule(
    "/components/meetingNotificationNavigation.ts"
  );
  const prepare = () => new Promise((r) => (release = r));
  return {
    row,
    calls,
    store,
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
