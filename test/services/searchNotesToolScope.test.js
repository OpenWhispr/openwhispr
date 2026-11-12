const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Workspace A is active. Its Private (1), its teamspace (2) and a teamspace linked to no
// workspace (6) are in scope; workspace B's Private (4) and teamspace (3) are not.
const SPACES = [
  { id: 1, name: "Personal", kind: "private", workspace_id: "a", cloud_space_id: null },
  { id: 4, name: "Personal", kind: "private", workspace_id: "b", cloud_space_id: null },
  { id: 2, name: "Alpha", kind: "team", workspace_id: "a", cloud_space_id: "cloud-alpha" },
  { id: 3, name: "Beta", kind: "team", workspace_id: "b", cloud_space_id: "cloud-beta" },
  { id: 6, name: "Legacy", kind: "team", workspace_id: null, cloud_space_id: "cloud-legacy" },
];
const SCOPE = [1, 2, 6];

const note = (id, spaceId, title) => ({
  id,
  title,
  content: `${title}: pricing tiers`,
  enhanced_content: null,
  note_type: "personal",
  space_id: spaceId,
  folder_id: null,
  created_at: "2026-11-01 10:00:00",
  updated_at: "2026-11-01 10:00:00",
});
const OWN_PRIVATE = note(11, 1, "Own private plan");
const OTHER_PRIVATE = note(44, 4, "Other workspace private plan");
const OTHER_TEAM = note(33, 3, "Beta team plan");
const ALPHA_NOTE = note(22, 2, "Alpha roadmap");
// An Alpha note this device has since moved into workspace B's Private.
const MOVED_AWAY = note(45, 4, "Moved away");
const NOTES = [OWN_PRIVATE, OTHER_PRIVATE, OTHER_TEAM, ALPHA_NOTE, MOVED_AWAY];

const cloudRow = (spaceId, title, clientNoteId = null, score = 0.9) => ({
  id: `cloud-${title}`,
  client_note_id: clientNoteId,
  title,
  content: `${title}: pricing tiers`,
  enhanced_content: null,
  note_type: "personal",
  created_at: "2026-11-01 10:00:00",
  score,
  space_id: spaceId,
});

// The cloud as the API answers: one space when named (plus, here, a personal row it shouldn't
// send), else every accessible space with the caller's personal rows.
const cloudAnswering = (rows) => async (_query, _limit, _scope, spaceId) => ({
  notes: spaceId ? rows.filter((row) => row.space_id === spaceId || row.space_id === null) : rows,
});

let calls;
test.beforeEach(async () => {
  calls = { semantic: [], keyword: [] };
  global.window = {
    location: { origin: "https://desktop.test" },
    electronAPI: {
      getSpaces: async () => SPACES,
      // Main is the scope's authority; these answer as if it applied none, the worst case.
      semanticSearchNotes: async (...args) => {
        calls.semantic.push(args);
        return [OTHER_PRIVATE, OWN_PRIVATE, OTHER_TEAM];
      },
      searchNotes: async (...args) => {
        calls.keyword.push(args);
        return [OTHER_PRIVATE, OWN_PRIVATE];
      },
      getNote: async (id) => NOTES.find((candidate) => candidate.id === id) ?? null,
      getNoteForCloudRow: async (clientNoteId) =>
        ({
          "own-key": OWN_PRIVATE,
          "alpha-key": ALPHA_NOTE,
          "moved-key": MOVED_AWAY,
        })[clientNoteId] ?? null,
      getSpeakerMappings: async () => [],
      getFolders: async () => [
        { id: 101, name: "Plans", space_id: 1 },
        { id: 104, name: "Other plans", space_id: 4 },
        { id: 102, name: "Roadmaps", space_id: 2 },
        { id: 103, name: "Beta docs", space_id: 3 },
      ],
    },
  };
  const auth = await import("../../src/lib/authRequestContext.ts");
  auth.resetAuthRequestContextForTests();
  global.window.electronAPI.authGetTokenState = async () => ({
    token: "test-token",
    generation: 1,
  });
  await auth.handleAuthRequestSuccess({
    data: { user: { id: "account-a" }, session: { id: "session" } },
    response: new Response("{}"),
    request: {
      url: "https://auth.test/get-session",
      headers: { Authorization: "Bearer test-token" },
      openWhisprAuthGeneration: 1,
    },
  });
  assert.equal(auth.commitValidatedAuthContext(1, "account-a"), true);
});

test.afterEach(() => {
  delete global.window;
});

const loadSearch = async () =>
  (await import("../../src/services/tools/searchNotesTool.ts")).createSearchNotesTool;

test("search_notes never returns another workspace's private note", async () => {
  const createSearchNotesTool = await loadSearch();
  const tool = createSearchNotesTool({ useCloudSearch: false, scopeSpaceIds: SCOPE });

  const result = await tool.execute({ query: "pricing" });
  assert.deepEqual(
    result.data.map((found) => found.id),
    [OWN_PRIVATE.id]
  );
  assert.doesNotMatch(JSON.stringify(result.data), /Other workspace|Beta team/);
  // Main is asked for the scope's spaces only.
  assert.deepEqual(calls.semantic.at(-1).at(-1), SCOPE);

  // The other workspace's teamspace can't be named, and isn't offered.
  const beta = await tool.execute({ query: "pricing", space: "Beta" });
  assert.equal(beta.success, false);
  assert.equal(
    beta.displayText,
    'Space "Beta" not found. Available spaces: Personal, Alpha, Legacy'
  );

  // "Personal" is the active workspace's Private, never workspace B's.
  const personal = await tool.execute({ query: "pricing", space: "Personal" });
  assert.deepEqual(
    personal.data.map((found) => found.id),
    [OWN_PRIVATE.id]
  );
  assert.deepEqual(calls.semantic.at(-1).at(-1), [1]);
});

test("a keyword fallback keeps the same scope", async () => {
  const createSearchNotesTool = await loadSearch();
  global.window.electronAPI.semanticSearchNotes = async () => {
    throw new Error("index down");
  };
  const result = await createSearchNotesTool({
    useCloudSearch: false,
    scopeSpaceIds: SCOPE,
  }).execute({ query: "pricing" });
  assert.deepEqual(
    result.data.map((found) => found.id),
    [OWN_PRIVATE.id]
  );
  assert.deepEqual(calls.keyword.at(-1).at(-1), SCOPE);
});

test("a container chat's search stays inside the scope", async () => {
  const createSearchNotesTool = await loadSearch();
  // A container of another workspace (a chat left open across a switch) searches nothing.
  const hidden = await createSearchNotesTool({
    useCloudSearch: true,
    fixedScope: { spaceId: 4, folderId: null },
    scopeSpaceIds: SCOPE,
  }).execute({ query: "pricing" });
  assert.deepEqual(hidden.data, []);
  assert.deepEqual(calls.semantic.at(-1).at(-1), []);
});

test("a non-empty cloud answer no longer hides local private matches", async (t) => {
  const { NotesService } = await import("../../src/services/NotesService.ts");
  const search = t.mock.method(NotesService, "search", async () => ({
    notes: [cloudRow("cloud-alpha", "Alpha cloud plan")],
  }));
  const createSearchNotesTool = await loadSearch();

  const result = await createSearchNotesTool({
    useCloudSearch: true,
    scopeSpaceIds: SCOPE,
  }).execute({ query: "pricing" });

  assert.deepEqual(
    result.data.map((found) => found.id),
    [OWN_PRIVATE.id]
  );
  assert.equal(search.mock.callCount(), 0, "local answered, so the cloud isn't asked");
});

test("a cloud personal row never reaches the model", async (t) => {
  const { NotesService } = await import("../../src/services/NotesService.ts");
  global.window.electronAPI.semanticSearchNotes = async () => [];
  global.window.electronAPI.searchNotes = async () => [];
  const rows = [
    // A stale Backup copy of a private note: personal rows carry no space.
    cloudRow(null, "Backup copy", "own-key"),
    cloudRow("cloud-beta", "Beta cloud plan"),
    cloudRow("cloud-alpha", "Alpha cloud plan", "alpha-key"),
    cloudRow("cloud-alpha", "Alpha moved plan", "moved-key"),
    cloudRow("cloud-unknown", "Unmapped plan"),
    cloudRow("cloud-legacy", "Legacy cloud plan", null, 0.95),
  ];
  const search = t.mock.method(NotesService, "search", cloudAnswering(rows));
  const createSearchNotesTool = await loadSearch();

  // Each teamspace in scope is asked on its own, so the server sends no personal rows, and
  // the answers are merged by score.
  const both = await createSearchNotesTool({
    useCloudSearch: true,
    scopeSpaceIds: SCOPE,
  }).execute({ query: "pricing" });
  assert.deepEqual(
    both.data.map((found) => found.title),
    ["Legacy cloud plan", "Alpha cloud plan", "Alpha moved plan"]
  );
  assert.deepEqual(
    both.data.map((found) => found.space),
    ["Legacy", "Alpha", "Alpha"]
  );
  // The moved copy's local note is in another workspace now: no id leads to it.
  assert.deepEqual(
    both.data.map((found) => found.id),
    [null, ALPHA_NOTE.id, null]
  );
  assert.doesNotMatch(JSON.stringify(both.data), /Backup copy|Beta cloud|Unmapped/);
  assert.deepEqual(
    search.mock.calls.map((call) => call.arguments),
    [
      ["pricing", 5, undefined, "cloud-alpha", 1],
      ["pricing", 5, undefined, "cloud-legacy", 1],
    ]
  );

  // Private alone: nothing in scope lives in the cloud, so it's never asked.
  const calls = search.mock.callCount();
  const privateOnly = await createSearchNotesTool({
    useCloudSearch: true,
    scopeSpaceIds: [1],
  }).execute({ query: "pricing" });
  assert.deepEqual(privateOnly.data, []);
  assert.equal(search.mock.callCount(), calls);
});

test("past ten teamspaces every request remains server scoped", async (t) => {
  const { NotesService } = await import("../../src/services/NotesService.ts");
  const teams = Array.from({ length: 11 }, (_, index) => ({
    id: 100 + index,
    name: `Team ${index}`,
    kind: "team",
    workspace_id: "a",
    cloud_space_id: `cloud-team-${index}`,
  }));
  Object.assign(global.window.electronAPI, {
    getSpaces: async () => [...SPACES, ...teams],
    semanticSearchNotes: async () => [],
    searchNotes: async () => [],
  });
  const search = t.mock.method(
    NotesService,
    "search",
    cloudAnswering([
      cloudRow(null, "Backup copy", "own-key"),
      cloudRow("cloud-team-3", "Team three plan"),
      cloudRow("cloud-beta", "Beta cloud plan"),
    ])
  );
  const createSearchNotesTool = await loadSearch();
  const result = await createSearchNotesTool({
    useCloudSearch: true,
    scopeSpaceIds: [1, ...teams.map((team) => team.id)],
  }).execute({ query: "pricing" });
  assert.deepEqual(
    result.data.map((found) => found.title),
    ["Team three plan"]
  );
  assert.deepEqual(
    search.mock.calls.map((call) => call.arguments),
    teams.map((team) => ["pricing", 5, undefined, team.cloud_space_id, 1])
  );
});

test("a limit past the API's maximum is clamped", async (t) => {
  const { NotesService } = await import("../../src/services/NotesService.ts");
  global.window.electronAPI.searchNotes = async (...args) => {
    calls.keyword.push(args);
    return [];
  };
  global.window.electronAPI.semanticSearchNotes = async (...args) => {
    calls.semantic.push(args);
    return [];
  };
  const search = t.mock.method(NotesService, "search", async () => ({ notes: [] }));
  const createSearchNotesTool = await loadSearch();
  await createSearchNotesTool({ useCloudSearch: true, scopeSpaceIds: [1, 2] }).execute({
    query: "pricing",
    limit: 500,
  });
  assert.equal(calls.semantic.at(-1)[1], 50);
  assert.equal(calls.keyword.at(-1)[1], 50);
  assert.deepEqual(search.mock.calls.at(-1).arguments, [
    "pricing",
    50,
    undefined,
    "cloud-alpha",
    1,
  ]);
});

test("teamspace cloud search needs a signed-in account, not Cloud Backup", async (t) => {
  // The registry's create_note reads the saved active workspace from storage.
  installBrowserGlobals(t, { window: { electronAPI: global.window.electronAPI } });
  const { NotesService } = await import("../../src/services/NotesService.ts");
  global.window.electronAPI.semanticSearchNotes = async () => [];
  global.window.electronAPI.searchNotes = async () => [];
  const search = t.mock.method(
    NotesService,
    "search",
    cloudAnswering([cloudRow("cloud-alpha", "Alpha cloud plan")])
  );
  const { createToolRegistry } = await import("../../src/services/tools/index.ts");
  const settings = {
    calendarConnected: false,
    cloudBackupEnabled: false,
    webSearchEnabled: false,
    scopeSpaceIds: [1, 2],
  };

  const signedIn = createToolRegistry({ ...settings, isSignedIn: true }).get("search_notes");
  const found = await signedIn.execute({ query: "pricing" });
  assert.deepEqual(
    found.data.map((row) => row.title),
    ["Alpha cloud plan"]
  );
  assert.equal(search.mock.callCount(), 1);

  const signedOut = createToolRegistry({ ...settings, isSignedIn: false }).get("search_notes");
  assert.deepEqual((await signedOut.execute({ query: "pricing" })).data, []);
  assert.equal(search.mock.callCount(), 1);
});

test("get_note refuses another workspace's private note and reads the open note", async () => {
  const { createGetNoteTool } = await import("../../src/services/tools/getNoteTool.ts");
  const getNote = createGetNoteTool({ spaceIds: SCOPE });

  const refused = await getNote.execute({ id: OTHER_PRIVATE.id });
  assert.equal(refused.success, false);
  assert.equal(refused.displayText, `Note with ID ${OTHER_PRIVATE.id} not found`);
  assert.equal(refused.data, null);
  assert.equal((await getNote.execute({ id: `${OTHER_TEAM.id}` })).success, false);

  const own = await getNote.execute({ id: OWN_PRIVATE.id });
  assert.equal(own.success, true);
  assert.equal(own.data.title, OWN_PRIVATE.title);

  // A note's own chat reads its note wherever it is: its text is already the chat's subject.
  const openNoteChat = createGetNoteTool({ spaceIds: SCOPE, openNoteId: OTHER_PRIVATE.id });
  assert.equal((await openNoteChat.execute({ id: OTHER_PRIVATE.id })).success, true);
  assert.equal((await openNoteChat.execute({ id: OTHER_TEAM.id })).success, false);
});

test("list_folders lists the folders in scope only", async () => {
  const { createListFoldersTool } = await import("../../src/services/tools/listFoldersTool.ts");
  const result = await createListFoldersTool({ spaceIds: SCOPE }).execute({});
  assert.deepEqual(result.data, [
    { id: 101, name: "Plans", space: "Personal" },
    { id: 102, name: "Roadmaps", space: "Alpha" },
  ]);
  assert.doesNotMatch(result.displayText, /Other plans|Beta/);
});

test("update_note refuses another workspace's private note", async (t) => {
  const updates = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getNote: async (id) => NOTES.find((candidate) => candidate.id === id) ?? null,
        updateNote: async (id, changes) => {
          updates.push({ id, changes });
          return { success: true, note: { ...NOTES.find((n) => n.id === id), ...changes } };
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-update-note-scope-",
    mockModules: {
      "/SyncService.js": "export const syncService = { debouncedPush() {} };",
    },
  });
  const { createUpdateNoteTool } = await vite.ssrLoadModule("/services/tools/updateNoteTool.ts");
  const updateNote = createUpdateNoteTool({ spaceIds: SCOPE });

  const refused = await updateNote.execute({ id: OTHER_PRIVATE.id, title: "Renamed" });
  assert.equal(refused.success, false);
  assert.equal(refused.displayText, `Note with ID ${OTHER_PRIVATE.id} not found`);
  assert.deepEqual(updates, []);

  const own = await updateNote.execute({ id: OWN_PRIVATE.id, title: "Renamed" });
  assert.equal(own.success, true);
  assert.deepEqual(updates, [{ id: OWN_PRIVATE.id, changes: { title: "Renamed" } }]);

  const openNoteChat = createUpdateNoteTool({ spaceIds: SCOPE, openNoteId: OTHER_PRIVATE.id });
  assert.equal(
    (await openNoteChat.execute({ id: OTHER_PRIVATE.id, title: "Renamed" })).success,
    true
  );
});

for (const allFail of [false, true]) {
  test(`large cloud search bounds concurrency and tolerates partial failure (${allFail})`, async (t) => {
    const { NotesService } = await import("../../src/services/NotesService.ts");
    const teams = Array.from({ length: 24 }, (_, index) => ({
      id: index + 100,
      name: `Team ${index}`,
      kind: "team",
      cloud_space_id: `team-${index}`,
    }));
    Object.assign(globalThis.window.electronAPI, {
      getSpaces: async () => teams,
      semanticSearchNotes: async () => [],
      searchNotes: async () => [],
    });
    let active = 0;
    let peak = 0;
    let completed = 0;
    t.mock.method(NotesService, "search", async (_query, limit, scope, spaceId) => {
      assert.equal(scope, undefined);
      assert.ok(spaceId);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      completed++;
      if (allFail || spaceId === "team-0") throw new Error("offline");
      // A scope=all result would be saturated with unrelated high-score rows.
      return {
        notes: [
          cloudRow(null, "Private copy", null, 100),
          cloudRow("outsider", "Other", null, 99),
          cloudRow(spaceId, spaceId, null, Number(spaceId.split("-")[1])),
        ],
      };
    });
    const create = await loadSearch();
    const result = await create({
      useCloudSearch: true,
      scopeSpaceIds: teams.map((team) => team.id),
    }).execute({ query: "pricing", limit: 3 });
    assert.equal(completed, 24);
    assert.ok(peak <= 10, `peak ${peak}`);
    assert.equal(result.success, !allFail);
    if (!allFail)
      assert.deepEqual(
        result.data.map((row) => row.title),
        ["team-23", "team-22", "team-21"]
      );
  });
}

test("an empty folder-pinned team search never widens to cloud", async (t) => {
  const { NotesService } = await import("../../src/services/NotesService.ts");
  const search = t.mock.method(NotesService, "search", async () => ({ notes: [] }));
  globalThis.window.electronAPI.semanticSearchNotes = async () => [];
  globalThis.window.electronAPI.searchNotes = async () => [];
  const create = await loadSearch();
  const result = await create({
    useCloudSearch: true,
    fixedScope: { spaceId: 2, folderId: 102 },
    scopeSpaceIds: SCOPE,
  }).execute({ query: "pricing" });
  assert.deepEqual(result.data, []);
  assert.equal(search.mock.callCount(), 0);
});
