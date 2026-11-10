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

async function fixture(
  t,
  {
    workspaceState = {},
    spaces: initialSpaces = spaces,
    folders: initialFolders = folders,
    notes: allNotes = notes,
  } = {}
) {
  const liveSpaces = [...initialSpaces];
  const liveFolders = [...initialFolders];
  // While held, space reads wait until the test answers them, in any order.
  let heldSpaceReads = null;
  installBrowserGlobals(t, { initialStorage: { activeWorkspaceId: "a" } });
  globalThis.window.electronAPI = {
    getSpaces: () =>
      heldSpaceReads
        ? new Promise((resolve) => heldSpaceReads.push(() => resolve([...liveSpaces])))
        : Promise.resolve([...liveSpaces]),
    getFolders: async () => [...liveFolders],
    getFolderNoteCounts: async () => [],
    getNotes: async (_type, _limit, folderId, spaceId) =>
      allNotes.filter((note) =>
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
    // What a successful list read does: the workspaces and both choices at once.
    listAnswers: (state) => useWorkspaceStore.setState(state),
    holdSpaceReads: () => {
      heldSpaceReads = [];
      return heldSpaceReads;
    },
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

test("signing in lands on the Private once the list names the workspace", async (t) => {
  // The tree loads before the first list: no workspace yet, so no bound Private shows.
  const f = await fixture(t, {
    workspaceState: {
      workspaces: [],
      loaded: false,
      activeWorkspaceId: null,
      defaultWorkspaceId: null,
      listAccountId: null,
    },
  });
  await f.settle();
  assert.deepEqual(f.context(), { folderId: null, noteId: null });

  f.listAnswers({
    workspaces: [
      { id: "a", name: "A", role: "member", is_default: true },
      { id: "b", name: "B", role: "member", is_default: false },
    ],
    loaded: true,
    activeWorkspaceId: "a",
    defaultWorkspaceId: "a",
    listAccountId: "account-1",
  });
  await f.settle();
  assert.deepEqual(f.context(), { folderId: 10, noteId: null });
});

test("switching back before a new workspace's Private arrives lands on the old one", async (t) => {
  const f = await fixture(t);
  await f.settle();
  f.switchTo("c");
  assert.deepEqual(f.context(), { folderId: null, noteId: null });
  f.switchTo("a");
  assert.deepEqual(f.context(), { folderId: 10, noteId: null });
  await f.publishScope();
  await f.settle();
  assert.deepEqual(f.context(), { folderId: 10, noteId: null });
});

test("the Private lands from whichever space read brings it", async (t) => {
  const f = await fixture(t);
  await f.settle();
  f.switchTo("c");
  f.putSpace({ id: 5, kind: "private", workspace_id: "c", name: "Personal" });
  f.putFolder({ id: 50, space_id: 5, name: "Personal", is_default: 1 });
  const reads = f.holdSpaceReads();
  await f.publishScope();
  await f.settle();
  // Another read starts before the scope's own one answers, so that one is dropped as stale.
  const other = f.store.loadSpaces();
  await f.settle();
  assert.equal(reads.length, 2);
  reads[0]();
  await f.settle();
  reads[1]();
  await other;
  await f.settle();
  assert.deepEqual(f.context(), { folderId: 50, noteId: null });
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

// The first launch after the update: the account's notes are in the pending Private (9), the
// default A has its own (1), and the saved workspace B has none yet.
const withPending = {
  spaces: [
    { id: 9, kind: "private", workspace_id: null, name: "Personal" },
    ...spaces.filter((s) => s.id !== 4),
  ],
  folders: [{ id: 90, space_id: 9, name: "Personal", is_default: 1 }, ...folders],
  notes: [{ id: 900, space_id: 9, folder_id: 90, title: "Pending note" }, ...notes],
};
const listedAB = [
  { id: "a", name: "A", role: "member", is_default: true },
  { id: "b", name: "B", role: "member", is_default: false },
];

test("the first list answer keeps the saved workspace and closes the note the tree picked", async (t) => {
  const f = await fixture(t, {
    ...withPending,
    workspaceState: {
      workspaces: [],
      loaded: false,
      activeWorkspaceId: "b",
      defaultWorkspaceId: null,
      listAccountId: null,
    },
  });
  await f.settle();
  // Before the list, the pending Private shows and the tree opened its first note.
  assert.deepEqual(f.context(), { folderId: 90, noteId: 900 });

  f.listAnswers({
    workspaces: listedAB,
    loaded: true,
    activeWorkspaceId: "b",
    defaultWorkspaceId: "a",
    listAccountId: "account-1",
  });
  await f.settle();
  assert.equal(f.activeWorkspaceId(), "b", "the saved workspace stays active");
  assert.deepEqual(f.context(), { folderId: null, noteId: null });

  // B's Private arrives once main hears the workspace.
  f.putSpace({ id: 4, kind: "private", workspace_id: "b", name: "Personal" });
  f.putFolder({ id: 40, space_id: 4, name: "Personal", is_default: 1 });
  await f.publishScope();
  await f.settle();
  assert.deepEqual(f.context(), { folderId: 40, noteId: null });
  assert.equal(f.activeWorkspaceId(), "b");
});

test("opening a pending private note from search in another workspace enters the default", async (t) => {
  const f = await fixture(t, {
    ...withPending,
    workspaceState: { workspaces: listedAB, activeWorkspaceId: "b", defaultWorkspaceId: "a" },
  });
  await f.settle();
  // CommandSearch picks the result: its folder, then the note.
  f.store.setActiveFolderId(90);
  assert.equal(f.activeWorkspaceId(), "a");
  await f.settle();
  f.store.setActiveNoteId(900);
  assert.deepEqual(f.context(), { folderId: 90, noteId: 900 });
  assert.equal(f.activeWorkspaceId(), "a");
});

test("a list refresh changes nothing while a note is open", async (t) => {
  const f = await fixture(t, {
    workspaceState: { workspaces: listedAB, activeWorkspaceId: "b", defaultWorkspaceId: "a" },
  });
  await f.settle();
  f.store.setActiveFolderId(40);
  await f.settle();
  f.store.setActiveNoteId(400);
  assert.deepEqual(f.context(), { folderId: 40, noteId: 400 });

  f.listAnswers({ workspaces: listedAB.map((w) => ({ ...w })) });
  await f.settle();
  assert.deepEqual(f.context(), { folderId: 40, noteId: 400 });
  assert.equal(f.activeWorkspaceId(), "b");
});

test("a workspace that arrives still takes the user to the teamspace they opened", async (t) => {
  // An invitation link opens a teamspace of a workspace the list doesn't hold yet.
  const f = await fixture(t, { workspaceState: { workspaces: listedAB } });
  await f.settle();
  f.putSpace({ id: 8, kind: "team", workspace_id: "d", name: "Invited" });
  await f.store.loadSpaces();
  f.store.setActiveContext(8, null);
  await f.settle();
  assert.equal(f.activeWorkspaceId(), "a");

  f.listAnswers({ workspaces: [...listedAB, { id: "d", name: "D", role: "member" }] });
  await f.settle();
  assert.equal(f.activeWorkspaceId(), "d");
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

// What Copy to Private's toast opens: the copy main made, which the store may not hold yet.
async function copyFixture(t, copy) {
  const all = [...notes, copy];
  const f = await fixture(t, { notes: all });
  globalThis.window.electronAPI.getNote = async (id) => all.find((note) => note.id === id) ?? null;
  await f.settle();
  // The user was in A's teamspace, on the note they copied.
  f.store.setActiveContext(2, null);
  await f.settle();
  return f;
}

test("the copy toast's Open doesn't switch workspace for a same-workspace copy", async (t) => {
  const copy = { id: 150, space_id: 1, folder_id: 10, title: "Alpha note (copy)" };
  const f = await copyFixture(t, copy);

  f.store.openNote(copy);
  await f.settle();
  assert.equal(f.activeWorkspaceId(), "a");
  assert.deepEqual(f.context(), { folderId: 10, noteId: 150 });
});

test("the copy toast's Open enters the workspace whose Private holds the copy", async (t) => {
  const copy = { id: 450, space_id: 4, folder_id: 40, title: "Alpha note (copy)" };
  const f = await copyFixture(t, copy);

  f.store.openNote(copy);
  await f.settle();
  assert.equal(f.activeWorkspaceId(), "b");
  assert.deepEqual(f.context(), { folderId: 40, noteId: 450 });
});
