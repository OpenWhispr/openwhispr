const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

for (const { name, saved, expected } of [
  {
    name: "refresh selects and persists Enterprise first when no workspace is saved",
    saved: null,
    expected: "enterprise",
  },
  {
    name: "refresh replaces a missing saved workspace with Enterprise and persists it",
    saved: "missing",
    expected: "enterprise",
  },
  {
    name: "refresh preserves a valid saved workspace even when Enterprise is available",
    saved: "business",
    expected: "business",
  },
]) {
  test(name, async (t) => {
    const { storage } = installBrowserGlobals(t, {
      initialStorage: saved ? { activeWorkspaceId: saved } : {},
    });
    const vite = await createRendererServer(t, {
      cachePrefix: "openwhispr-workspace-store-",
      mockModules: {
        "/services/WorkspacesService": `
          export const WorkspacesService = {
            list: async () => [
              { id: "business", plan: "business", status: "active" },
              { id: "enterprise", plan: "enterprise", status: "active" },
            ],
          };
        `,
        "/policyStore": `
          export const usePolicyStore = {
            getState: () => ({ accountId: null, authGeneration: null }),
          };
        `,
        "/enterpriseIdentityStore": `
          export const useEnterpriseIdentityStore = { getState: () => ({ clear() {} }) };
        `,
      },
    });
    const { useWorkspaceStore, ACTIVE_WORKSPACE_KEY } = await vite.ssrLoadModule(
      "/stores/workspaceStore.ts"
    );

    assert.equal(useWorkspaceStore.getState().activeWorkspaceId, saved);
    await useWorkspaceStore.getState().refresh();

    assert.deepEqual(
      useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id),
      ["business", "enterprise"]
    );
    assert.equal(useWorkspaceStore.getState().activeWorkspaceId, expected);
    assert.equal(storage.getItem(ACTIVE_WORKSPACE_KEY), expected);
  });
}
