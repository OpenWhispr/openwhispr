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
  const { storage } = installBrowserGlobals(t, { initialStorage });
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
      "/services/WorkspacesService": `
        export const WorkspacesService = {
          list: () => globalThis.__workspaceCacheTest.list(),
        };
      `,
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
  return { storage, store: useWorkspaceStore };
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
