const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const LIST = {
  folders: [{ id: 7, name: "Old plans", is_default: 0, noteCount: 1 }],
  notes: [
    {
      id: 70,
      title: "Q3 plan",
      folder_id: 7,
      created_at: "",
      updated_at: "",
      note_type: "personal",
    },
    {
      id: 71,
      title: "Loose",
      folder_id: null,
      created_at: "",
      updated_at: "",
      note_type: "personal",
    },
  ],
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

// The real note store drives the view's navigation, so its own dependencies are stubbed.
async function fixture(t, { list = LIST, deviceNote = (id) => ({ id }) } = {}) {
  const calls = { lists: 0, folders: 0, moves: [] };
  const listeners = {};
  installBrowserGlobals(t);
  globalThis.window.electronAPI = {
    getDeviceNotes: async () => {
      calls.lists += 1;
      return list;
    },
    getDeviceNote: async (id) => deviceNote(id),
    moveDeviceNotes: async (request) => {
      calls.moves.push(request);
      return { success: true, moved: [{ id: 70, space_id: 1, folder_id: null }], skipped: 0 };
    },
    onDeviceNotesChanged: (callback) => {
      listeners.changed = callback;
      return () => delete listeners.changed;
    },
    getDatabaseAccountScope: async () => ({ accountId: "a", visibleAccountId: "a" }),
    onDatabaseAccountScopeChanged: (callback) => {
      listeners.scope = callback;
      return () => delete listeners.scope;
    },
    getFolders: async () => {
      calls.folders += 1;
      return [];
    },
    getFolderNoteCounts: async () => [],
    getNotes: async () => [],
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-device-notes-store-",
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
  const store = await vite.ssrLoadModule("/stores/deviceNotesStore.ts");
  const notes = await vite.ssrLoadModule("/stores/noteStore.ts");
  const state = () => store.useDeviceNotesStore.getState();
  return { store, notes, state, calls, listeners };
}

async function listening(t, options) {
  const env = await fixture(t, options);
  const stop = env.state().startListening();
  t.after(stop);
  await settle();
  return env;
}

test("load() fills folders and notes", async (t) => {
  const { state } = await fixture(t);
  await state().load();
  assert.deepEqual(state().folders, LIST.folders);
  assert.deepEqual(state().notes, LIST.notes);
});

test("account-scope change reloads and closes the view", async (t) => {
  const { state, calls, listeners } = await listening(t);
  state().openView(70);
  const listsBefore = calls.lists;

  listeners.scope({ accountId: "b", visibleAccountId: "b" });
  await settle();
  assert.equal(state().viewNoteId, null);
  assert.equal(calls.lists, listsBefore + 1);

  // A move after the switch is the new account's.
  await state().move({ noteIds: [71] }, { workspaceId: null });
  assert.equal(calls.moves[0].accountId, "b");
});

test("device-notes-changed closes a view whose note is gone", async (t) => {
  let present = true;
  const { state, listeners } = await listening(t, {
    deviceNote: (id) => (present ? { id } : null),
  });
  state().openView(70);

  listeners.changed();
  await settle();
  assert.equal(state().viewNoteId, 70, "a note still on the list stays open");

  present = false;
  listeners.changed();
  await settle();
  assert.equal(state().viewNoteId, null);
});

test("opening a normal note closes the view", async (t) => {
  const { state, notes } = await listening(t);
  state().openView(70);

  notes.setActiveNoteId(null);
  assert.equal(state().viewNoteId, 70, "clearing the open note is how the view opens");

  notes.setActiveNoteId(42);
  assert.equal(state().viewNoteId, null);

  notes.setActiveNoteId(null);
  state().openView(70);
  notes.setActiveContext(1, null);
  assert.equal(state().viewNoteId, null, "opening a container closes it too");
});

test("move() refreshes folders and the list", async (t) => {
  const { state, calls } = await listening(t);
  const listsBefore = calls.lists;

  const result = await state().move({ folderId: 7 }, { workspaceId: "w" });
  assert.deepEqual(calls.moves, [{ folderId: 7, workspaceId: "w", accountId: "a" }]);
  assert.equal(result.moved[0].id, 70);
  assert.equal(calls.folders, 1);
  assert.equal(calls.lists, listsBefore + 1);
});
