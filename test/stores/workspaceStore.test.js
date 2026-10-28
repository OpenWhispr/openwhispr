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

async function loadStoreWithDeferredMembers(t) {
  installBrowserGlobals(t, { initialStorage: { activeWorkspaceId: "A" } });
  // Each listMembers call waits until the test answers it, so requests can interleave.
  globalThis.__memberRequests = [];
  t.after(() => {
    delete globalThis.__memberRequests;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-store-members-",
    mockModules: {
      "/services/WorkspacesService": `
        export const WorkspacesService = {
          list: async () => [],
          listMembers: (workspaceId) =>
            new Promise((resolve, reject) => {
              globalThis.__memberRequests.push({ workspaceId, resolve, reject });
            }),
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
  const store = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  const roster = await vite.ssrLoadModule("/lib/peopleRoster.ts");
  return { ...store, ...roster, requests: globalThis.__memberRequests };
}

const PEOPLE_A = [{ user_id: "a1", email: "ann@a.com", name: "Ann", role: "owner" }];
const PEOPLE_B = [{ user_id: "b1", email: "bob@b.com", name: "Bob", role: "owner" }];

test("a member list for another workspace never replaces the active one's", async (t) => {
  const { useWorkspaceStore, rosterFor, requests } = await loadStoreWithDeferredMembers(t);
  const store = useWorkspaceStore.getState();

  // A role change in A is in flight when the user switches to B; B's tab loads its roster, then
  // the role change's re-read for A starts last.
  store.setActiveWorkspaceId("B");
  const loadB = store.refreshMembers("B");
  const rereadA = store.refreshMembers("A");
  requests[0].resolve(PEOPLE_B);
  requests[1].resolve(PEOPLE_A);
  await Promise.all([loadB, rereadA]);

  const state = useWorkspaceStore.getState();
  assert.deepEqual(rosterFor(state, "B"), []);
  assert.equal(state.membersWorkspaceId, "A");
  assert.deepEqual(rosterFor(state, "A"), PEOPLE_A);
});

test("a roster stays tied to its workspace until the store forgets it", async (t) => {
  const { useWorkspaceStore, rosterFor, requests } = await loadStoreWithDeferredMembers(t);
  const store = useWorkspaceStore.getState();

  const loadA = store.refreshMembers("A");
  requests[0].resolve(PEOPLE_A);
  await loadA;
  assert.equal(useWorkspaceStore.getState().membersWorkspaceId, "A");
  assert.deepEqual(rosterFor(useWorkspaceStore.getState(), "A"), PEOPLE_A);

  // A roster read for B after the switch, answered once B is active, is B's.
  store.setActiveWorkspaceId("B");
  assert.equal(useWorkspaceStore.getState().membersWorkspaceId, null);
  assert.deepEqual(rosterFor(useWorkspaceStore.getState(), "A"), []);
  const loadB = store.refreshMembers("B");
  requests[1].resolve(PEOPLE_B);
  await loadB;
  assert.deepEqual(rosterFor(useWorkspaceStore.getState(), "B"), PEOPLE_B);

  useWorkspaceStore.setState({ workspaces: [{ id: "A" }, { id: "B" }] });
  useWorkspaceStore.getState().forgetWorkspace("B");
  assert.equal(useWorkspaceStore.getState().membersWorkspaceId, null);
  assert.deepEqual(useWorkspaceStore.getState().members, []);

  const reloadA = useWorkspaceStore.getState().refreshMembers("A");
  requests[2].resolve(PEOPLE_A);
  await reloadA;
  useWorkspaceStore.getState().resetForAccountChange();
  assert.equal(useWorkspaceStore.getState().membersWorkspaceId, null);
  assert.deepEqual(useWorkspaceStore.getState().members, []);
});

test("forgetting a workspace that isn't the roster's keeps the roster", async (t) => {
  const { useWorkspaceStore, rosterFor, requests } = await loadStoreWithDeferredMembers(t);
  useWorkspaceStore.setState({ workspaces: [{ id: "A" }, { id: "B" }, { id: "C" }] });
  const loadA = useWorkspaceStore.getState().refreshMembers("A");
  requests[0].resolve(PEOPLE_A);
  await loadA;

  useWorkspaceStore.getState().forgetWorkspace("C");
  assert.deepEqual(rosterFor(useWorkspaceStore.getState(), "A"), PEOPLE_A);
});

test("a read overtaken by a newer read of the same workspace settles with that read", async (t) => {
  const { useWorkspaceStore, rosterFor, requests } = await loadStoreWithDeferredMembers(t);
  const store = useWorkspaceStore.getState();

  // Two role changes in a row: the first one's re-read answers first but is overtaken.
  let firstSettled = false;
  const first = store.refreshMembers("A").then(() => {
    firstSettled = true;
  });
  const second = store.refreshMembers("A");
  requests[0].resolve([{ ...PEOPLE_A[0], role: "admin" }]);
  await new Promise((resolve) => setImmediate(resolve));

  // Settling now would let its caller report a change the roster doesn't show yet.
  assert.equal(firstSettled, false);
  assert.deepEqual(rosterFor(useWorkspaceStore.getState(), "A"), []);

  requests[1].resolve(PEOPLE_A);
  await Promise.all([first, second]);
  assert.deepEqual(rosterFor(useWorkspaceStore.getState(), "A"), PEOPLE_A);
});

test("an overtaken read shares the newer read's failure", async (t) => {
  const { useWorkspaceStore, requests } = await loadStoreWithDeferredMembers(t);
  const store = useWorkspaceStore.getState();

  const first = store.refreshMembers("A");
  const second = store.refreshMembers("A");
  requests[0].resolve(PEOPLE_A);
  requests[1].reject(new Error("offline"));

  await assert.rejects(first, /offline/);
  await assert.rejects(second, /offline/);
});
