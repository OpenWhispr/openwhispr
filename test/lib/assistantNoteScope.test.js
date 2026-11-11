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

async function loadResolver(t, electronAPI) {
  installBrowserGlobals(t, {
    initialStorage: { activeWorkspaceId: "a" },
    window: { electronAPI },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-assistant-scope-" });
  const { resolveAssistantScopeSpaceIds } = await vite.ssrLoadModule("/lib/assistantNoteScope.ts");
  const { useWorkspaceStore } = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  return { resolve: resolveAssistantScopeSpaceIds, useWorkspaceStore };
}

const sorted = (ids) => [...ids].sort((x, y) => x - y);

test("the dictation window, with no workspace list, reads main's Private and the active workspace's teamspaces", async (t) => {
  const { resolve } = await loadResolver(t, {
    getSpaces: async () => SPACES,
    getPrivateSpaceId: async () => 1,
    getDefaultPrivateSpaceId: async () => 1,
  });
  assert.deepEqual(sorted(await resolve()), [1, 2, 6, 9]);
});

test("a window holding the workspace list reads what its tree shows", async (t) => {
  let defaultAsked = 0;
  const { resolve, useWorkspaceStore } = await loadResolver(t, {
    getSpaces: async () => SPACES,
    getPrivateSpaceId: async () => 1,
    getDefaultPrivateSpaceId: async () => {
      defaultAsked++;
      return 1;
    },
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
  assert.equal(defaultAsked, 0);
});

test("a scope that can't be resolved fails closed to main's Private", async (t) => {
  const { resolve } = await loadResolver(t, {
    getSpaces: async () => {
      throw new Error("database closed");
    },
    getPrivateSpaceId: async () => 1,
    getDefaultPrivateSpaceId: async () => 1,
  });
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
