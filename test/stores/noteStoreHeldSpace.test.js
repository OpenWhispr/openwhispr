const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const spaces = [
  { id: 1, kind: "private", workspace_id: null, name: "Personal" },
  { id: 2, kind: "team", cloud_space_id: "cloud-2", workspace_id: null, name: "Roadmap" },
];
const folders = [
  { id: 10, space_id: 1, name: "Personal", is_default: 1 },
  { id: 20, space_id: 2, name: "Plans", is_default: 0 },
];
const notes = [
  { id: 101, space_id: 1, folder_id: 10, title: "Mine", client_note_id: "c101", deleted_at: null },
  {
    id: 201,
    space_id: 2,
    folder_id: 20,
    title: "Team plan",
    client_note_id: "c201",
    sync_status: "synced",
    cloud_id: "n201",
    deleted_at: null,
  },
];

async function fixture(t) {
  installBrowserGlobals(t);
  const purged = [];
  let spacePurged;
  globalThis.window.electronAPI = {
    onSpacePurged: (listener) => {
      spacePurged = listener;
      return () => {};
    },
    getSpaces: async () => spaces,
    getFolders: async () => folders,
    getFolderNoteCounts: async () => [],
    getNotes: async (_type, _limit, folderId) =>
      notes.filter((note) => note.folder_id === folderId),
    getNote: async (id) => notes.find((note) => note.id === id) ?? null,
    purgeSpace: async (id) => {
      purged.push(id);
      return { success: true };
    },
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-note-store-held-space-",
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
  const held = await vite.ssrLoadModule("/lib/heldSpaceDeletes.ts");
  const heldTeams = await vite.ssrLoadModule("/lib/heldTeamDeletes.ts");
  const conflicts = await vite.ssrLoadModule("/lib/noteConflictRegistry.ts");
  await store.initializeNotesTree();
  const hide = () => {
    held.holdSpace(2, "cloud-2");
    return store.hideSpaceInView(2);
  };
  const release = () => held.releaseSpace(2, "cloud-2");
  const view = () => ({
    spaces: store.getSpacesValue(),
    folders: store.getFoldersValue(),
    activeNoteId: store.getActiveNoteIdValue(),
    activeFolderId: store.getActiveFolderIdValue(),
  });
  const openTeamNote = async () => {
    store.setActiveContext(2, 20);
    await store.ensureContainerLoaded(store.folderContainerKey(20));
    store.setActiveNoteId(201);
  };
  return {
    store,
    held,
    heldTeams,
    conflicts,
    purged,
    hide,
    release,
    view,
    openTeamNote,
    purge: (id) => spacePurged({ spaceId: id }),
  };
}

const spaceIds = (view) => view().spaces.map((space) => space.id);
const folderIds = (view) => view().folders.map((folder) => folder.id);
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a held space leaves the view, the open note closes, and the view lands on Personal", async (t) => {
  const { hide, view, openTeamNote, purged } = await fixture(t);
  await openTeamNote();

  hide();
  await settle();

  assert.deepEqual(spaceIds(view), [1]);
  assert.deepEqual(folderIds(view), [10]);
  assert.equal(view().activeNoteId, null);
  assert.equal(view().activeFolderId, 10);
  assert.deepEqual(purged, [], "its rows stay on this device");
});

test("a sync pass reloading the lists doesn't bring a held space back", async (t) => {
  const { store, hide, view } = await fixture(t);
  hide();

  await store.loadSpaces();
  await store.loadFolders();

  assert.deepEqual(spaceIds(view), [1]);
  assert.deepEqual(folderIds(view), [10]);
});

test("Undo brings the space back and returns to the note the user was reading", async (t) => {
  const { hide, release, view, openTeamNote } = await fixture(t);
  await openTeamNote();
  const bringBack = hide();
  await settle();

  release();
  await bringBack(true);

  assert.deepEqual(spaceIds(view), [1, 2]);
  assert.deepEqual(folderIds(view), [10, 20]);
  assert.equal(view().activeFolderId, 20);
  assert.equal(view().activeNoteId, 201);
});

test("Undo restores what the hold collapsed and keeps what changed meanwhile", async (t) => {
  const { store, hide, release } = await fixture(t);
  const teamFolder = store.folderContainerKey(20);
  const personal = store.folderContainerKey(10);
  store.setContainerExpanded(teamFolder, true);
  const bringBack = hide();
  await settle();
  store.setContainerExpanded(personal, true);

  release();
  await bringBack(true);

  const expanded = JSON.parse(globalThis.localStorage.getItem("notesTree.expanded"));
  assert.ok(expanded.includes(teamFolder), "the hold's collapse is undone");
  assert.ok(expanded.includes(personal), "what the user opened meanwhile stays open");
});

test("Undo stays put if the user went to another folder with no note open", async (t) => {
  const { store, hide, release, view, openTeamNote } = await fixture(t);
  await openTeamNote();
  const bringBack = hide();
  await settle();
  store.setActiveContext(1, null);

  release();
  await bringBack(true);

  assert.equal(view().activeNoteId, null);
  assert.equal(view().activeFolderId, null);
});

test("an unresolved conflict in a held space survives the hold, and goes with the real purge", async (t) => {
  const { store, hide, release, purge, conflicts } = await fixture(t);
  store.setNoteConflict("c201", { space_id: "cloud-2", title: "Theirs" });
  const bringBack = hide();
  await settle();
  assert.ok(conflicts.readNoteConflictIds().has("c201"), "the hold changes only the view");

  release();
  await bringBack(true);
  assert.ok(conflicts.readNoteConflictIds().has("c201"));

  hide();
  await settle();
  purge(2);
  await settle();
  assert.equal(conflicts.readNoteConflictIds().has("c201"), false);
});

test("the real purge finds a folder opened while the space was held", async (t) => {
  const { store, hide, purge, view } = await fixture(t);
  hide();
  await settle();
  // Search reads the database directly, so it can still open a note in the hidden space.
  store.setActiveNoteId(201);
  await store.ensureNoteLoaded(201);
  assert.ok(store.getNoteFromStore(201));

  purge(2);
  await settle();

  assert.equal(store.getNoteFromStore(201), null);
  assert.equal(view().activeNoteId, null);
});

test("an account change forgets what was held", async (t) => {
  const { store, hide, held } = await fixture(t);
  hide();
  assert.equal(held.isSpaceHeld(2), true);

  store.resetForAccountChange();

  assert.equal(held.isSpaceHeld(2), false);
  assert.equal(held.heldCloudSpaceIds().size, 0);
});

test("an account change forgets held teams too", async (t) => {
  const { store, heldTeams } = await fixture(t);
  heldTeams.holdTeam("team-1");
  assert.equal(heldTeams.isTeamHeld("team-1"), true);

  store.resetForAccountChange();

  assert.equal(heldTeams.isTeamHeld("team-1"), false);
  assert.equal(heldTeams.heldTeamIds().size, 0);
});

test("Undo leaves the user where they went in the meantime", async (t) => {
  const { store, hide, release, view, openTeamNote } = await fixture(t);
  await openTeamNote();
  const bringBack = hide();
  await settle();
  store.setActiveContext(1, 10);
  store.setActiveNoteId(101);

  release();
  await bringBack(true);

  assert.deepEqual(spaceIds(view), [1, 2]);
  assert.equal(view().activeFolderId, 10);
  assert.equal(view().activeNoteId, 101);
});

test("a failed delete brings the space back without moving the view", async (t) => {
  const { hide, release, view, openTeamNote } = await fixture(t);
  await openTeamNote();
  const bringBack = hide();
  await settle();

  release();
  await bringBack(false);

  assert.deepEqual(spaceIds(view), [1, 2]);
  assert.equal(view().activeFolderId, 10);
  assert.equal(view().activeNoteId, null);
});
