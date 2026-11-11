const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("./rendererTestHarness");

const SPACES = [
  { id: 1, kind: "private", workspace_id: "a" },
  { id: 9, kind: "private", workspace_id: null },
  { id: 5, kind: "private", workspace_id: "b" },
  { id: 2, kind: "team", workspace_id: "a" },
  { id: 3, kind: "team", workspace_id: "b" },
  { id: 6, kind: "team", workspace_id: null },
];

async function loadResolver(
  t,
  electronAPI,
  { activeWorkspaceId = "a", storage = {}, accountId = null } = {}
) {
  installBrowserGlobals(t, {
    initialStorage: { ...(activeWorkspaceId ? { activeWorkspaceId } : {}), ...storage },
    window: { electronAPI },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-assistant-scope-" });
  const { resolveAssistantScopeSpaceIds } = await vite.ssrLoadModule("/lib/assistantNoteScope.ts");
  const { useWorkspaceStore } = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  if (accountId) usePolicyStore.setState({ accountId });
  return { resolve: resolveAssistantScopeSpaceIds, useWorkspaceStore, usePolicyStore };
}

const sorted = (ids) => [...ids].sort((x, y) => x - y);

test("the dictation window, with no workspace list, reads the active workspace's Private and teamspaces", async (t) => {
  const asked = [];
  const { resolve } = await loadResolver(t, {
    getSpaces: async () => SPACES,
    getPrivateSpaceId: async (...args) => {
      asked.push(args);
      return 1;
    },
  });
  // Nothing says which workspace is the default: the pending Private shows merged in.
  assert.deepEqual(sorted(await resolve()), [1, 2, 6, 9]);
  // Main is never asked for a named workspace's Private: that could make a row (D37).
  assert.deepEqual(asked, [[]]);
});

test("while main lags, a workspace known not to be the default reads none of the default's Private", async (t) => {
  // Main hasn't taken the scope yet: unnamed, it answers the default workspace B's Private,
  // which it bound earlier.
  const spaces = SPACES.map((space) =>
    space.id === 5 ? { ...space, is_default_private: 1 } : space
  );
  const { resolve } = await loadResolver(t, {
    getSpaces: async () => spaces,
    getPrivateSpaceId: async () => 5,
  });
  assert.deepEqual(sorted(await resolve()), [1, 2, 6]);
});

test("the dictation window knows the default from the last list this account saw", async (t) => {
  const { resolve, usePolicyStore } = await loadResolver(
    t,
    { getSpaces: async () => SPACES, getPrivateSpaceId: async () => 1 },
    {
      storage: {
        workspaceListCache: JSON.stringify({
          accountId: "account-1",
          fetchedAt: Date.now(),
          workspaces: [
            { id: "a", name: "A", role: "member" },
            { id: "b", name: "B", role: "owner", is_default: true },
          ],
        }),
      },
      accountId: "account-1",
    }
  );
  assert.ok(usePolicyStore);
  // B is the default: the pending notes are B's, not A's.
  assert.deepEqual(sorted(await resolve()), [1, 2, 6]);
});

test("a window holding the workspace list reads what its tree shows", async (t) => {
  const { resolve, useWorkspaceStore } = await loadResolver(t, {
    getSpaces: async () => SPACES,
    getPrivateSpaceId: async () => 1,
  });
  useWorkspaceStore.setState({
    workspaces: [
      { id: "a", name: "A", role: "member" },
      { id: "b", name: "B", role: "member" },
    ],
    defaultWorkspaceId: "b",
    loaded: true,
  });
  // A isn't the default: the pending Private is B's until main binds it.
  assert.deepEqual(sorted(await resolve()), [1, 2, 6]);
});

test("a scope that can't be resolved reads nothing while a workspace is active", async (t) => {
  const { resolve } = await loadResolver(t, {
    getSpaces: async () => {
      throw new Error("database closed");
    },
    getPrivateSpaceId: async () => 1,
    getDefaultPrivateSpaceId: async () => 1,
  });
  // Without the spaces, which workspace main's Private belongs to can't be checked.
  assert.deepEqual(await resolve(), []);
});

test("with no workspace active, a scope that can't be resolved is main's Private", async (t) => {
  const { resolve } = await loadResolver(
    t,
    {
      getSpaces: async () => {
        throw new Error("database closed");
      },
      getPrivateSpaceId: async () => 1,
    },
    { activeWorkspaceId: null }
  );
  assert.deepEqual(await resolve(), [1]);
});

test("with not even main's Private known, the scope is empty, never every space", async (t) => {
  const { resolve } = await loadResolver(t, {
    getSpaces: async () => SPACES,
    getPrivateSpaceId: async () => {
      throw new Error("database closed");
    },
  });
  assert.deepEqual(await resolve(), []);
});
