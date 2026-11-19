const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("old member and workspace replies cannot repopulate state after a switch or account reset", async (t) => {
  installBrowserGlobals(t);
  const pendingMembers = [];
  const pendingLists = [];
  const pendingCreates = [];
  globalThis.__pendingWorkspaceMembers = pendingMembers;
  globalThis.__pendingWorkspaceLists = pendingLists;
  globalThis.__pendingWorkspaceCreates = pendingCreates;
  t.after(() => {
    delete globalThis.__pendingWorkspaceMembers;
    delete globalThis.__pendingWorkspaceLists;
    delete globalThis.__pendingWorkspaceCreates;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-store-test-",
    mockModules: {
      "/services/WorkspacesService": `
        export const WorkspacesService = {
          listMembers: () => new Promise((resolve) => globalThis.__pendingWorkspaceMembers.push(resolve)),
          list: () => new Promise((resolve) => globalThis.__pendingWorkspaceLists.push(resolve)),
          create: () => new Promise((resolve) => globalThis.__pendingWorkspaceCreates.push(resolve)),
        };
      `,
      "/utils/logger": `export default { error() {} };`,
      "/stores/policyStore": `export const usePolicyStore = { getState: () => ({ accountId: null, authGeneration: null }) };`,
      "/stores/enterpriseIdentityStore": `export const useEnterpriseIdentityStore = { getState: () => ({ clear() {} }) };`,
    },
  });
  const { useWorkspaceStore } = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  const store = useWorkspaceStore;
  store.setState({
    workspaces: [{ id: "one" }, { id: "two" }],
    activeWorkspaceId: "one",
    loaded: true,
  });
  const old = store.getState().refreshMembers("one");
  store.getState().setActiveWorkspaceId("two");
  pendingMembers.shift()([{ user_id: "old" }]);
  await old;
  assert.deepEqual(store.getState().members, [], "a switch drops the old workspace's reply");
  assert.equal(store.getState().membersWorkspaceId, null);

  const current = store.getState().refreshMembers("two");
  const oldList = store.getState().refresh();
  const oldCreate = store.getState().createWorkspace("Old account workspace");
  store.getState().resetForAccountChange();
  pendingMembers.shift()([{ user_id: "previous-account" }]);
  pendingLists.shift()([{ id: "old-workspace" }]);
  pendingCreates.shift()({ id: "old-workspace" });
  assert.equal(await oldCreate, null);
  await Promise.all([current, oldList]);
  assert.deepEqual(store.getState().members, []);
  assert.equal(store.getState().membersWorkspaceId, null);
  assert.deepEqual(store.getState().workspaces, []);
  assert.equal(store.getState().loaded, false);
});
