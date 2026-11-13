const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Workspace A is active. Its Private (1), its teamspace (2) and a teamspace linked to no
// workspace (6) are in scope; workspace B's Private (4) and teamspace (3) are not.
const SPACES = [
  {
    id: 1,
    name: "Personal",
    kind: "private",
    workspace_id: "a",
    cloud_space_id: null,
    is_default_private: 1,
  },
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

test("cloud-first search returns the server ranking without reading the local indexes", async (t) => {
  const { NotesService } = await import("../../src/services/NotesService.ts");
  const search = t.mock.method(NotesService, "search", async () => ({
    notes: [cloudRow("cloud-alpha", "Alpha cloud plan")],
  }));
  const create = await loadSearch();
  const result = await create({ useCloudSearch: true, scopeSpaceIds: SCOPE }).execute({
    query: "pricing",
  });
  assert.deepEqual(
    result.data.map((row) => row.title),
    ["Alpha cloud plan"]
  );
  assert.deepEqual(calls, { semantic: [], keyword: [] });
  assert.deepEqual(search.mock.calls[0].arguments, [
    "pricing",
    5,
    "all",
    undefined,
    1,
    { spaceIds: ["cloud-alpha", "cloud-legacy"], privateWorkspaceId: "a" },
  ]);
});

for (const cloudFails of [false, true]) {
  test(`cloud empty/error falls back to semantic then keyword (${cloudFails})`, async (t) => {
    const { NotesService } = await import("../../src/services/NotesService.ts");
    const order = [];
    t.mock.method(NotesService, "search", async () => {
      order.push("cloud");
      if (cloudFails) throw new Error("offline");
      return { notes: [] };
    });
    global.window.electronAPI.semanticSearchNotes = async () => {
      order.push("semantic");
      return [];
    };
    global.window.electronAPI.searchNotes = async (...args) => {
      order.push("keyword");
      calls.keyword.push(args);
      return [OWN_PRIVATE];
    };
    const create = await loadSearch();
    const result = await create({ useCloudSearch: true, scopeSpaceIds: SCOPE }).execute({
      query: "pricing",
    });
    assert.deepEqual(
      result.data.map((row) => row.id),
      [OWN_PRIVATE.id]
    );
    assert.deepEqual(order, ["cloud", "semantic", "keyword"]);
    assert.deepEqual(calls.keyword[0].at(-1), SCOPE);
  });
}

test("cloud Private results preserve scope and protect the chat before content is returned", async (t) => {
  const { NotesService } = await import("../../src/services/NotesService.ts");
  const rows = [
    { ...cloudRow(null, "Backup copy", "own-key"), private_workspace_id: "a" },
    { ...cloudRow(null, "Cloud only Private"), private_workspace_id: "a" },
    cloudRow(null, "Legacy default"),
    { ...cloudRow(null, "Other Private"), private_workspace_id: "b" },
    cloudRow(null, "Moved legacy", "moved-key"),
    { ...cloudRow(null, "Legacy workspace"), workspace_id: "a" },
    cloudRow("cloud-beta", "Beta cloud plan"),
    cloudRow("cloud-alpha", "Alpha cloud plan", "alpha-key"),
    cloudRow("cloud-alpha", "Alpha moved plan", "moved-key"),
  ];
  t.mock.method(NotesService, "search", cloudAnswering(rows));
  const protectedCalls = [];
  const create = await loadSearch();
  const result = await create({
    useCloudSearch: true,
    scopeSpaceIds: SCOPE,
    protectNotes: async (notes, deviceOnly) => {
      protectedCalls.push({ notes, deviceOnly });
    },
  }).execute({ query: "pricing", limit: 20 });
  assert.deepEqual(
    result.data.map((row) => row.title),
    ["Backup copy", "Cloud only Private", "Legacy default", "Alpha cloud plan", "Alpha moved plan"]
  );
  assert.deepEqual(
    result.data.map((row) => row.id),
    [11, null, null, 22, null]
  );
  assert.equal(protectedCalls.length, 1);
  assert.equal(protectedCalls[0].deviceOnly, true);
  assert.deepEqual(
    protectedCalls[0].notes.map((row) => row.id),
    [11, 22]
  );
  assert.deepEqual(calls, { semantic: [], keyword: [] });
});

test("a Private cloud result cannot escape a failed privacy checkpoint", async (t) => {
  const { NotesService } = await import("../../src/services/NotesService.ts");
  t.mock.method(NotesService, "search", async () => ({
    notes: [{ ...cloudRow(null, "PRIVATE CANARY"), private_workspace_id: "a" }],
  }));
  const create = await loadSearch();
  const result = await create({
    useCloudSearch: true,
    scopeSpaceIds: [1],
    protectNotes: async () => {
      throw new Error("privacy unavailable");
    },
  }).execute({ query: "pricing" });
  assert.equal(result.success, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE CANARY|Own private plan/);
});

test("cloud-only Private text waits for durable chat protection", async (t) => {
  const { NotesService } = await import("../../src/services/NotesService.ts");
  t.mock.method(NotesService, "search", async () => ({
    notes: [{ ...cloudRow(null, "Private canary"), private_workspace_id: "a" }],
  }));
  let release;
  let entered;
  const protecting = new Promise((resolve) => {
    entered = resolve;
  });
  const protectedChat = new Promise((resolve) => {
    release = resolve;
  });
  let completed = false;
  const create = await loadSearch();
  const result = create({
    useCloudSearch: true,
    scopeSpaceIds: [1],
    protectNotes: async (notes, deviceOnly) => {
      assert.deepEqual(notes, []);
      assert.equal(deviceOnly, true);
      entered();
      await protectedChat;
    },
  })
    .execute({ query: "pricing" })
    .then((value) => {
      completed = true;
      return value;
    });
  await protecting;
  assert.equal(completed, false);
  release();
  assert.equal((await result).data[0].title, "Private canary");
});

test("a pending default Private uses the turn's workspace without widening scope", async (t) => {
  const { NotesService } = await import("../../src/services/NotesService.ts");
  global.window.electronAPI.getSpaces = async () => [
    { id: 1, name: "Private", kind: "private", workspace_id: null },
  ];
  const search = t.mock.method(NotesService, "search", async () => ({
    notes: [
      { ...cloudRow(null, "Pending bound"), private_workspace_id: "a" },
      cloudRow(null, "Unproven legacy"),
    ],
  }));
  const create = await loadSearch();
  const result = await create({
    useCloudSearch: true,
    scopeSpaceIds: [1],
    privateWorkspaceId: "a",
  }).execute({ query: "pricing" });
  assert.deepEqual(search.mock.calls[0].arguments.at(-1), {
    spaceIds: [],
    privateWorkspaceId: "a",
  });
  assert.deepEqual(
    result.data.map((row) => row.title),
    ["Pending bound"]
  );
});

test("named Private searches cloud personal notes within the active workspace", async (t) => {
  const { NotesService } = await import("../../src/services/NotesService.ts");
  const search = t.mock.method(NotesService, "search", async () => ({
    notes: [{ ...cloudRow(null, "Backup copy"), private_workspace_id: "a" }],
  }));
  const create = await loadSearch();
  const result = await create({ useCloudSearch: true, scopeSpaceIds: SCOPE }).execute({
    query: "pricing",
    space: "Personal",
  });
  assert.deepEqual(
    result.data.map((row) => row.title),
    ["Backup copy"]
  );
  assert.deepEqual(search.mock.calls[0].arguments.at(-1), {
    spaceIds: [],
    privateWorkspaceId: "a",
  });
});

test("legacy NULL Private results require default placement or an in-scope local copy", async (t) => {
  const { NotesService } = await import("../../src/services/NotesService.ts");
  t.mock.method(NotesService, "search", async () => ({
    notes: [
      cloudRow(null, "Unknown legacy"),
      { ...cloudRow(null, "B Private"), private_workspace_id: "b" },
    ],
  }));
  const create = await loadSearch();
  const result = await create({ useCloudSearch: true, scopeSpaceIds: [4] }).execute({
    query: "pricing",
  });
  assert.deepEqual(
    result.data.map((row) => row.title),
    ["B Private"]
  );
});

test("many teamspaces still use a single ranked request with an exact allowed scope", async (t) => {
  const { NotesService } = await import("../../src/services/NotesService.ts");
  const teams = Array.from({ length: 24 }, (_, index) => ({
    id: index + 100,
    name: `Team ${index}`,
    kind: "team",
    cloud_space_id: `team-${index}`,
  }));
  global.window.electronAPI.getSpaces = async () => teams;
  const search = t.mock.method(NotesService, "search", async () => ({
    notes: [
      cloudRow("team-23", "First", null, 0.5),
      cloudRow("team-1", "Second", null, 0.9),
      cloudRow(null, "Excluded Private"),
      cloudRow("foreign", "Excluded team"),
    ],
  }));
  const create = await loadSearch();
  const result = await create({
    useCloudSearch: true,
    scopeSpaceIds: teams.map((team) => team.id),
  }).execute({ query: "pricing" });
  assert.equal(search.mock.callCount(), 1);
  assert.deepEqual(search.mock.calls[0].arguments.at(-1), {
    spaceIds: teams.map((team) => team.cloud_space_id),
    privateWorkspaceId: null,
  });
  assert.deepEqual(
    result.data.map((row) => row.title),
    ["First", "Second"]
  );
});

test("a limit past the API maximum is clamped for every strategy", async (t) => {
  const { NotesService } = await import("../../src/services/NotesService.ts");
  global.window.electronAPI.semanticSearchNotes = async (...args) => {
    calls.semantic.push(args);
    return [];
  };
  global.window.electronAPI.searchNotes = async (...args) => {
    calls.keyword.push(args);
    return [];
  };
  const search = t.mock.method(NotesService, "search", async () => ({ notes: [] }));
  const create = await loadSearch();
  await create({ useCloudSearch: true, scopeSpaceIds: SCOPE }).execute({
    query: "pricing",
    limit: 500,
  });
  assert.equal(search.mock.calls[0].arguments[1], 50);
  assert.equal(calls.semantic[0][1], 50);
  assert.equal(calls.keyword[0][1], 50);
});

test("registry uses main's signed-in and Backup-enabled cloud-search gate", async (t) => {
  installBrowserGlobals(t, { window: { electronAPI: global.window.electronAPI } });
  const { NotesService } = await import("../../src/services/NotesService.ts");
  const search = t.mock.method(NotesService, "search", async () => ({
    notes: [cloudRow("cloud-alpha", "Alpha cloud plan")],
  }));
  const { createToolRegistry } = await import("../../src/services/tools/index.ts");
  const settings = { calendarConnected: false, webSearchEnabled: false, scopeSpaceIds: SCOPE };
  for (const [isSignedIn, cloudBackupEnabled] of [
    [false, false],
    [false, true],
    [true, false],
  ]) {
    const result = await createToolRegistry({ ...settings, isSignedIn, cloudBackupEnabled })
      .get("search_notes")
      .execute({ query: "pricing" });
    assert.deepEqual(
      result.data.map((row) => row.id),
      [OWN_PRIVATE.id]
    );
  }
  assert.equal(search.mock.callCount(), 0);
  const result = await createToolRegistry({
    ...settings,
    isSignedIn: true,
    cloudBackupEnabled: true,
  })
    .get("search_notes")
    .execute({ query: "pricing" });
  assert.deepEqual(
    result.data.map((row) => row.title),
    ["Alpha cloud plan"]
  );
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
