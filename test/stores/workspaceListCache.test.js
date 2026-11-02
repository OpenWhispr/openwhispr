const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const CACHE_KEY = "workspaceListCache";
const WORKSPACES = [
  {
    id: "team",
    plan: "business",
    status: "active",
    capabilities: { manage_members: true, create_spaces: true },
  },
];

// accountId and the service's list result are read from globals so each test steers them.
async function loadStore(t, { initialStorage = {}, accountId = "acct-1", list } = {}) {
  const { storage } = installBrowserGlobals(t, {
    initialStorage,
    window: { dispatchEvent() {} },
  });
  globalThis.__workspaceCacheTest = {
    accountId,
    list: list ?? (async () => WORKSPACES),
  };
  t.after(() => {
    delete globalThis.__workspaceCacheTest;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-list-cache-",
    mockModules: {
      "/WorkspacesService": `
        export const WorkspacesService = {
          list: () => globalThis.__workspaceCacheTest.list(),
          create: (name) => globalThis.__workspaceCacheTest.create(name),
          listMembers: (id) => globalThis.__workspaceCacheTest.listMembers(id),
          removeMember: (id, userId) => globalThis.__workspaceCacheTest.remove(id, userId),
          remove: (id) => globalThis.__workspaceCacheTest.remove(id),
        };
      `,
      "/SyncService": `export const syncService = { requestSyncAll() {} };`,
      "/policyStore": `
        export const usePolicyStore = {
          getState: () => ({
            accountId: globalThis.__workspaceCacheTest.accountId,
            authGeneration: null,
          }),
        };
      `,
      "/enterpriseIdentityStore": `
        export const useEnterpriseIdentityStore = { getState: () => ({ clear() {} }) };
      `,
    },
  });
  const { useWorkspaceStore } = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  return { storage, store: useWorkspaceStore, vite };
}

const failing = async () => {
  throw new Error("offline");
};

const DAY_MS = 24 * 60 * 60 * 1000;

const cacheEntry = (accountId, workspaces = WORKSPACES, fetchedAt = Date.now()) =>
  JSON.stringify({ accountId, fetchedAt, workspaces });

test("successful refresh caches the list for this account", async (t) => {
  const { storage, store } = await loadStore(t);
  await store.getState().refresh();

  const cached = JSON.parse(storage.getItem(CACHE_KEY));
  assert.equal(cached.accountId, "acct-1");
  assert.equal(typeof cached.fetchedAt, "number");
  assert.deepEqual(cached.workspaces, WORKSPACES);
});

test("failed refresh falls back to this account's cache", async (t) => {
  const { store } = await loadStore(t, {
    initialStorage: { [CACHE_KEY]: cacheEntry("acct-1") },
    list: failing,
  });
  await store.getState().refresh();

  const state = store.getState();
  assert.deepEqual(state.workspaces, WORKSPACES);
  assert.equal(state.loaded, true);
  assert.equal(state.loading, false);
  assert.equal(state.error, true);
});

test("cache is ignored for another account", async (t) => {
  const { store } = await loadStore(t, {
    initialStorage: { [CACHE_KEY]: cacheEntry("acct-2") },
    list: failing,
  });
  await store.getState().refresh();

  assert.deepEqual(store.getState().workspaces, []);
  assert.equal(store.getState().error, true);
});

test("no account: nothing is cached and the cache is not read", async (t) => {
  const { storage, store } = await loadStore(t, { accountId: null });
  await store.getState().refresh();
  assert.equal(storage.getItem(CACHE_KEY), null);

  storage.setItem(CACHE_KEY, cacheEntry("acct-1"));
  store.getState().resetForAccountChange();
  globalThis.__workspaceCacheTest.list = failing;
  await store.getState().refresh();
  assert.deepEqual(store.getState().workspaces, []);
});

test("a failure with a list already in memory keeps that list", async (t) => {
  const other = [{ id: "memory", plan: "business", status: "active", capabilities: {} }];
  const { store } = await loadStore(t, {
    initialStorage: { [CACHE_KEY]: cacheEntry("acct-1") },
    list: async () => other,
  });
  await store.getState().refresh();
  globalThis.__workspaceCacheTest.list = failing;
  await store.getState().refresh();

  assert.deepEqual(store.getState().workspaces, other);
  assert.equal(store.getState().error, true);
});

test("account change clears the cache", async (t) => {
  const { storage, store } = await loadStore(t);
  await store.getState().refresh();
  assert.notEqual(storage.getItem(CACHE_KEY), null);

  store.getState().resetForAccountChange();
  assert.equal(storage.getItem(CACHE_KEY), null);
});

for (const [name, raw] of [
  ["bad JSON", "{not json"],
  [
    "workspaces not an array",
    JSON.stringify({ accountId: "acct-1", fetchedAt: Date.now(), workspaces: {} }),
  ],
  ["older than 30 days", cacheEntry("acct-1", WORKSPACES, Date.now() - 31 * DAY_MS)],
  ["no fetchedAt", JSON.stringify({ accountId: "acct-1", workspaces: WORKSPACES })],
  ["null entry", cacheEntry("acct-1", [null])],
  ["entry without a string id", cacheEntry("acct-1", [{ id: 7, plan: "business" }])],
]) {
  test(`unreadable cache is ignored (${name})`, async (t) => {
    const { store } = await loadStore(t, {
      initialStorage: { [CACHE_KEY]: raw },
      list: failing,
    });
    await store.getState().refresh();

    assert.deepEqual(store.getState().workspaces, []);
    assert.equal(store.getState().loaded, true);
    assert.equal(store.getState().error, true);
  });
}

test("forgetting a workspace drops it from the list and the cache", async (t) => {
  const two = [...WORKSPACES, { id: "gone", plan: "business", status: "active", capabilities: {} }];
  const { storage, store } = await loadStore(t, { list: async () => two });
  await store.getState().refresh();
  const fetchedAt = JSON.parse(storage.getItem(CACHE_KEY)).fetchedAt;

  store.getState().forgetWorkspace("gone");

  assert.deepEqual(store.getState().workspaces, WORKSPACES);
  const cached = JSON.parse(storage.getItem(CACHE_KEY));
  assert.deepEqual(cached.workspaces, WORKSPACES);
  // Pruning is not a fresh read, so the cache keeps its age.
  assert.equal(cached.fetchedAt, fetchedAt);
});

test("a refresh that fails after forgetting never brings the workspace back", async (t) => {
  const two = [...WORKSPACES, { id: "gone", plan: "business", status: "active", capabilities: {} }];
  const { store } = await loadStore(t, { list: async () => two });
  await store.getState().refresh();

  store.getState().forgetWorkspace("gone");
  globalThis.__workspaceCacheTest.list = failing;
  await store.getState().refresh();
  assert.deepEqual(store.getState().workspaces, WORKSPACES);
  assert.equal(store.getState().error, true);

  // With nothing in memory, the fallback reads the pruned cache.
  store.setState({ workspaces: [] });
  await store.getState().refresh();
  assert.deepEqual(store.getState().workspaces, WORKSPACES);
});

test("forgetting leaves another account's cache alone", async (t) => {
  const other = cacheEntry("acct-2", [{ id: "gone", plan: "business" }]);
  const { storage, store } = await loadStore(t, { initialStorage: { [CACHE_KEY]: other } });

  store.getState().forgetWorkspace("gone");

  assert.equal(storage.getItem(CACHE_KEY), other);
});

const GONE = { id: "gone", plan: "business", status: "active", capabilities: {} };

test("forgetting the active workspace makes the next one active, even if the refresh fails", async (t) => {
  const { store } = await loadStore(t, { list: async () => [GONE, ...WORKSPACES] });
  await store.getState().refresh();
  assert.equal(store.getState().activeWorkspaceId, "gone");

  store.getState().forgetWorkspace("gone");
  globalThis.__workspaceCacheTest.list = failing;
  await store.getState().refresh({ fresh: true });

  assert.equal(store.getState().activeWorkspaceId, "team");
  assert.equal(store.getState().error, true);
});

for (const action of ["leaveWorkspace", "deleteWorkspace"]) {
  test(`${action} with a lost response clears the departed roster and invalidates its pending fetch`, async (t) => {
    const { store, storage, vite } = await loadStore(t, {
      list: async () => [GONE, ...WORKSPACES],
    });
    const actions = await vite.ssrLoadModule("/services/workspaceActions.ts");
    const departedMembers = [{ user_id: "departed-user", role: "member" }];
    globalThis.__workspaceCacheTest.listMembers = async () => departedMembers;
    await store.getState().refresh();
    await store.getState().refreshMembers("gone");

    let answerStale;
    globalThis.__workspaceCacheTest.listMembers = () =>
      new Promise((resolve) => (answerStale = () => resolve(departedMembers)));
    const stale = store.getState().refreshMembers("gone");
    let membersAtSwitch;
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.activeWorkspaceId !== previous.activeWorkspaceId) membersAtSwitch = state.members;
    });
    t.after(unsubscribe);
    globalThis.__workspaceCacheTest.remove = async (id) => {
      assert.equal(id, "gone");
      globalThis.__workspaceCacheTest.list = async () => WORKSPACES;
      throw new Error("response lost");
    };

    await actions[action]("gone", "departed-user");

    assert.equal(store.getState().activeWorkspaceId, "team");
    assert.equal(storage.getItem("activeWorkspaceId"), "team");
    assert.deepEqual(store.getState().workspaces, WORKSPACES);
    assert.deepEqual(membersAtSwitch, []);
    assert.deepEqual(store.getState().members, []);
    answerStale();
    await stale;
    assert.deepEqual(store.getState().members, []);

    globalThis.__workspaceCacheTest.listMembers = failing;
    await assert.rejects(store.getState().refreshMembers("team"), /offline/);
    assert.deepEqual(store.getState().members, []);
  });
}

test("refreshing an unchanged active workspace preserves its roster and pending member fetch", async (t) => {
  const { store } = await loadStore(t);
  const members = [{ user_id: "existing-user", role: "member" }];
  globalThis.__workspaceCacheTest.listMembers = async () => members;
  await store.getState().refresh();
  await store.getState().refreshMembers("team");

  let answerMembers;
  const updatedMembers = [...members, { user_id: "new-user", role: "member" }];
  globalThis.__workspaceCacheTest.listMembers = () =>
    new Promise((resolve) => (answerMembers = () => resolve(updatedMembers)));
  const pending = store.getState().refreshMembers("team");
  await store.getState().refresh();

  assert.equal(store.getState().activeWorkspaceId, "team");
  assert.deepEqual(store.getState().members, members);
  answerMembers();
  await pending;
  assert.deepEqual(store.getState().members, updatedMembers);
});

test("a fresh refresh drops the answer of a request sent before the change", async (t) => {
  let answerStale;
  const { storage, store } = await loadStore(t, {
    list: () => new Promise((resolve) => (answerStale = () => resolve([GONE, ...WORKSPACES]))),
  });
  // A focus or reconnect refresh is in flight when the user leaves "gone".
  const stale = store.getState().refresh();
  globalThis.__workspaceCacheTest.list = async () => WORKSPACES;

  store.getState().forgetWorkspace("gone");
  const fresh = store.getState().refresh({ fresh: true });
  assert.notEqual(fresh, stale);
  await fresh;
  answerStale();
  await stale;

  assert.deepEqual(store.getState().workspaces, WORKSPACES);
  assert.equal(store.getState().activeWorkspaceId, "team");
  assert.deepEqual(JSON.parse(storage.getItem(CACHE_KEY)).workspaces, WORKSPACES);
});

test("a plain refresh still joins the request in flight", async (t) => {
  let calls = 0;
  const { store } = await loadStore(t, {
    list: async () => {
      calls++;
      return WORKSPACES;
    },
  });
  const first = store.getState().refresh();
  assert.equal(store.getState().refresh(), first);
  await first;
  assert.equal(calls, 1);
});

test("a workspace created while a refresh is in flight survives that refresh's answer", async (t) => {
  const created = { id: "new", plan: "free", status: "active", capabilities: {} };
  let answerStale;
  const { store } = await loadStore(t, {
    list: () => new Promise((resolve) => (answerStale = () => resolve(WORKSPACES))),
  });
  globalThis.__workspaceCacheTest.create = async () => created;
  const stale = store.getState().refresh();
  globalThis.__workspaceCacheTest.list = async () => [...WORKSPACES, created];

  await store.getState().createWorkspace("New");
  answerStale();
  await stale;
  // Let the request the create started settle; no new refresh is asked for here.
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    store.getState().workspaces.map((w) => w.id),
    ["team", "new"]
  );
});

test("creating with no refresh in flight asks the server nothing more", async (t) => {
  let lists = 0;
  const { store } = await loadStore(t, {
    list: async () => {
      lists++;
      return WORKSPACES;
    },
  });
  await store.getState().refresh();
  globalThis.__workspaceCacheTest.create = async () => ({
    id: "new",
    plan: "free",
    status: "active",
    capabilities: {},
  });

  await store.getState().createWorkspace("New");

  assert.equal(lists, 1);
  assert.deepEqual(
    store.getState().workspaces.map((w) => w.id),
    ["team", "new"]
  );
});
