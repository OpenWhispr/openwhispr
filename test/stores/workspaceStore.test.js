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
    const observedScopes = [];
    const unsubscribe = useWorkspaceStore.subscribe((state) => {
      if (state.loaded) {
        observedScopes.push({
          activeWorkspaceId: state.activeWorkspaceId,
          persistedWorkspaceId: storage.getItem(ACTIVE_WORKSPACE_KEY),
        });
      }
    });
    t.after(unsubscribe);
    await useWorkspaceStore.getState().refresh();

    assert.deepEqual(observedScopes, [
      { activeWorkspaceId: expected, persistedWorkspaceId: expected },
    ]);

    // The Enterprise workspace is the default of an account that has none of its own.
    assert.deepEqual(
      useWorkspaceStore.getState().workspaces.map((workspace) => workspace.id),
      ["enterprise", "business"]
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

// A store whose service, account and main-process calls each test steers through globalThis.__ws.
async function loadPrivateNotesStore(
  t,
  {
    list,
    ensureDefault = async () => null,
    accountId = "acct-1",
    storage: initialStorage = {},
    spaces = [],
    // Main's workspace calls, in place of the recording fakes (a real database, say).
    main = null,
  }
) {
  const calls = [];
  const accountScopeListeners = [];
  const fakeMain = {
    setActiveWorkspaceScope: async (scope) => {
      calls.push(["scope", scope]);
      return { success: true };
    },
    bindDefaultPrivateSpace: async (workspaceId, account) => {
      calls.push(["bind", workspaceId, account]);
      return { success: true };
    },
    relocatePrivateSpace: async (from, to, account) => {
      calls.push(["relocate", from, to, account]);
      if (globalThis.__ws.relocateThrows) {
        globalThis.__ws.relocateThrows -= 1;
        throw new Error("database is locked");
      }
      return { success: true, notes: 0, folders: 0 };
    },
    getSpaces: async () => {
      calls.push(["spaces"]);
      return globalThis.__ws.spaces;
    },
    claimSignedOutPrivateNotes: async () => {
      calls.push(["claim"]);
      return { notes: 0, folders: 0 };
    },
  };
  const api = {
    ...fakeMain,
    ...main,
    onDatabaseAccountScopeChanged: (listener) => {
      accountScopeListeners.push(listener);
      return () => accountScopeListeners.splice(accountScopeListeners.indexOf(listener), 1);
    },
  };
  const { storage } = installBrowserGlobals(t, {
    initialStorage,
    window: { electronAPI: api },
  });
  globalThis.__ws = {
    list,
    ensureDefault,
    accountId,
    spaces,
    relocateThrows: 0,
    ensureCalls: [],
    listCalls: 0,
  };
  t.after(() => {
    delete globalThis.__ws;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-store-default-",
    mockModules: {
      "/services/WorkspacesService": `
        export const WorkspacesService = {
          list: () => {
            globalThis.__ws.listCalls += 1;
            return globalThis.__ws.list();
          },
          ensureDefault: (name) => {
            globalThis.__ws.ensureCalls.push(name);
            return globalThis.__ws.ensureDefault(name);
          },
        };
      `,
      "/policyStore": `
        export const usePolicyStore = {
          getState: () => ({ accountId: globalThis.__ws.accountId, authGeneration: null }),
        };
      `,
      "/enterpriseIdentityStore": `
        export const useEnterpriseIdentityStore = { getState: () => ({ clear() {} }) };
      `,
    },
  });
  const store = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  return {
    ...store,
    storage,
    calls,
    vite,
    changeDatabaseAccount: (scope) => accountScopeListeners.forEach((listener) => listener(scope)),
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};
const names = (calls) => calls.map(([name]) => name);
const LIST_CACHE_KEY = "workspaceListCache";
const cacheFor = (accountId, workspaces) =>
  JSON.stringify({ accountId, fetchedAt: Date.now(), workspaces });

const OWN = { id: "own", plan: "free", status: "active", is_default: true };
const TEAM = { id: "team", plan: "business", status: "active", is_default: false };
const LOST = { id: "lost", plan: "business", status: "active", is_default: false };
const ENTERPRISE = { id: "corp", plan: "enterprise", status: "active", is_default: false };

test("a saved Personal choice becomes the default workspace", async (t) => {
  const { useWorkspaceStore, storage } = await loadPrivateNotesStore(t, {
    list: async () => [TEAM, OWN],
    storage: { workspacePersonalSelected: "true" },
  });

  await useWorkspaceStore.getState().refresh();

  const state = useWorkspaceStore.getState();
  assert.equal(state.defaultWorkspaceId, "own");
  assert.equal(state.activeWorkspaceId, "own");
  assert.equal(storage.getItem("activeWorkspaceId"), "own");
  assert.equal(storage.getItem("workspacePersonalSelected"), null);
  assert.equal("personalSelected" in state, false);
  assert.equal("selectPersonal" in state, false);
});

test("a workspace chosen before the first refresh wins over a saved Personal choice", async (t) => {
  const { useWorkspaceStore, storage } = await loadPrivateNotesStore(t, {
    list: async () => [TEAM, OWN],
    storage: { workspacePersonalSelected: "true" },
  });

  useWorkspaceStore.getState().setActiveWorkspaceId("team");
  await useWorkspaceStore.getState().refresh();

  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, "team");
  assert.equal(storage.getItem("workspacePersonalSelected"), null);
});

test("the default workspace is listed first and chosen when nothing is saved", async (t) => {
  const { useWorkspaceStore, storage } = await loadPrivateNotesStore(t, {
    list: async () => [TEAM, OWN],
  });

  await useWorkspaceStore.getState().refresh();

  const state = useWorkspaceStore.getState();
  assert.deepEqual(
    state.workspaces.map((w) => w.id),
    ["own", "team"]
  );
  assert.equal(state.defaultWorkspaceId, "own");
  assert.equal(state.activeWorkspaceId, "own");
  assert.equal(storage.getItem("activeWorkspaceId"), "own");
});

test("ensureDefaultWorkspace posts the localized name once and refreshes", async (t) => {
  const { useWorkspaceStore, ensureDefaultWorkspace } = await loadPrivateNotesStore(t, {
    list: async () => [TEAM],
    ensureDefault: async () => {
      globalThis.__ws.list = async () => [TEAM, OWN];
      return OWN;
    },
  });
  const { defaultWorkspaceName } = await import("../../src/lib/workspaceSwitcher.ts");
  const i18n = require("i18next").createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: require("../../src/locales/en/translation.json") } },
    interpolation: { escapeValue: false },
  });
  const t9n = i18n.t.bind(i18n);
  await useWorkspaceStore.getState().refresh();
  assert.equal(useWorkspaceStore.getState().defaultWorkspaceId, null);

  await Promise.all([
    ensureDefaultWorkspace(defaultWorkspaceName("Ada", t9n)),
    ensureDefaultWorkspace(defaultWorkspaceName("Ada", t9n)),
  ]);
  await ensureDefaultWorkspace(defaultWorkspaceName("Ada", t9n));

  assert.deepEqual(globalThis.__ws.ensureCalls, ["Ada's workspace"]);
  assert.equal(globalThis.__ws.listCalls, 2);
  assert.equal(useWorkspaceStore.getState().defaultWorkspaceId, "own");
  assert.equal(useWorkspaceStore.getState().workspaces[0].id, "own");

  // Each account session asks once.
  useWorkspaceStore.getState().resetForAccountChange();
  await ensureDefaultWorkspace(defaultWorkspaceName("", t9n));
  assert.deepEqual(globalThis.__ws.ensureCalls, ["Ada's workspace", "My workspace"]);
});

test("a failed ensureDefaultWorkspace is asked again", async (t) => {
  const { ensureDefaultWorkspace } = await loadPrivateNotesStore(t, {
    list: async () => [TEAM],
    ensureDefault: async () => {
      throw new Error("offline");
    },
  });

  await ensureDefaultWorkspace("Ada's workspace");
  globalThis.__ws.ensureDefault = async () => OWN;
  await ensureDefaultWorkspace("Ada's workspace");

  assert.equal(globalThis.__ws.ensureCalls.length, 2);
});

test("an enterprise_managed answer leaves the Enterprise workspace as default", async (t) => {
  const { useWorkspaceStore, ensureDefaultWorkspace } = await loadPrivateNotesStore(t, {
    list: async () => [TEAM, ENTERPRISE],
    // POST /api/workspaces/default answers { data: null, reason: "enterprise_managed" }.
    ensureDefault: async () => null,
  });
  await useWorkspaceStore.getState().refresh();

  await ensureDefaultWorkspace("Ada's workspace");

  const state = useWorkspaceStore.getState();
  assert.equal(state.defaultWorkspaceId, "corp");
  assert.equal(state.activeWorkspaceId, "corp");
  assert.equal(globalThis.__ws.listCalls, 1);
});

// Task 10 (a): Retry is how an unavailable list recovers, so it reads the list again even when
// the server makes no default (enterprise_managed) or the request fails.
test("Retry reads the list again when the server makes no default or fails", async (t) => {
  for (const [label, ensureDefault] of [
    ["enterprise_managed", async () => null],
    [
      "a failure",
      async () => {
        throw new Error("offline");
      },
    ],
  ]) {
    await t.test(label, async (st) => {
      const { useWorkspaceStore, ensureDefaultWorkspace } = await loadPrivateNotesStore(st, {
        list: async () => [TEAM],
        ensureDefault,
      });
      await useWorkspaceStore.getState().refresh();
      st.mock.method(console, "warn", () => {});
      // Meanwhile the server came to list the Enterprise workspace that stands in as default.
      globalThis.__ws.list = async () => [TEAM, ENTERPRISE];
      const reads = globalThis.__ws.listCalls;

      await ensureDefaultWorkspace("Ada's workspace", { again: true });

      assert.equal(globalThis.__ws.listCalls, reads + 1, "the list is read again");
      assert.equal(useWorkspaceStore.getState().defaultWorkspaceId, "corp");
    });
  }
});

test("a failed refresh relocates nothing", async (t) => {
  const { useWorkspaceStore, calls } = await loadPrivateNotesStore(t, {
    list: async () => {
      throw new Error("offline");
    },
    storage: { [LIST_CACHE_KEY]: cacheFor("acct-1", [OWN, TEAM, LOST]) },
  });

  await useWorkspaceStore.getState().refresh();

  assert.equal(useWorkspaceStore.getState().error, true);
  assert.deepEqual(
    useWorkspaceStore.getState().workspaces.map((w) => w.id),
    ["own", "team", "lost"]
  );
  assert.equal(names(calls).includes("relocate"), false);
});

test("an empty list after a load error relocates nothing", async (t) => {
  const { useWorkspaceStore, calls, storage } = await loadPrivateNotesStore(t, {
    list: async () => {
      throw new Error("offline");
    },
    storage: { [LIST_CACHE_KEY]: cacheFor("acct-1", [OWN, TEAM, LOST]) },
  });
  await useWorkspaceStore.getState().refresh();

  globalThis.__ws.list = async () => [];
  await useWorkspaceStore.getState().refresh({ fresh: true });

  assert.equal(names(calls).includes("relocate"), false);
  // Every account has a default workspace, so an empty answer never replaces the list it
  // would be compared against.
  assert.deepEqual(
    JSON.parse(storage.getItem(LIST_CACHE_KEY)).workspaces.map((w) => w.id),
    ["own", "team", "lost"]
  );
});

test("a list cached for another account relocates nothing", async (t) => {
  const { useWorkspaceStore, calls } = await loadPrivateNotesStore(t, {
    list: async () => [OWN, TEAM],
    storage: { [LIST_CACHE_KEY]: cacheFor("acct-2", [OWN, TEAM, LOST]) },
  });

  await useWorkspaceStore.getState().refresh();

  assert.equal(names(calls).includes("relocate"), false);
});

test("a successful list missing a workspace relocates its Private to the default", async (t) => {
  const { useWorkspaceStore, calls } = await loadPrivateNotesStore(t, {
    list: async () => [TEAM, OWN],
    storage: {
      activeWorkspaceId: "lost",
      // Older than the 30 days the cache is shown for: a workspace lost is lost at any age.
      [LIST_CACHE_KEY]: JSON.stringify({
        accountId: "acct-1",
        fetchedAt: Date.now() - 60 * 24 * 60 * 60 * 1000,
        workspaces: [OWN, TEAM, LOST],
      }),
    },
  });

  await useWorkspaceStore.getState().refresh();

  const relocations = calls.filter(([name]) => name === "relocate");
  assert.deepEqual(relocations, [["relocate", "lost", null, "acct-1"]]);
  // The lost workspace was active: main hears the default as active before its Private moves,
  // or the next read of the spaces would make the lost workspace a new Private.
  const relocateAt = calls.findIndex(([name]) => name === "relocate");
  const scopesBefore = calls.slice(0, relocateAt).filter(([name]) => name === "scope");
  assert.deepEqual(scopesBefore.at(-1), [
    "scope",
    { activeWorkspaceId: "own", defaultWorkspaceId: "own", accountId: "acct-1" },
  ]);
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, "own");
});

test("losing the active workspace sends the default's scope before its Private moves", async (t) => {
  const { useWorkspaceStore, relocateLostWorkspaces, calls } = await loadPrivateNotesStore(t, {
    list: async () => [OWN, TEAM],
    storage: { activeWorkspaceId: "team" },
  });
  await useWorkspaceStore.getState().refresh();
  calls.length = 0;

  useWorkspaceStore.getState().forgetWorkspace("team");
  await relocateLostWorkspaces(["team"]);

  assert.deepEqual(calls, [
    ["scope", { activeWorkspaceId: "own", defaultWorkspaceId: "own", accountId: "acct-1" }],
    ["relocate", "team", null, "acct-1"],
  ]);
});

test("nothing moves when main refuses the scope for another account", async (t) => {
  const { useWorkspaceStore, relocateLostWorkspaces, calls } = await loadPrivateNotesStore(t, {
    list: async () => [OWN, TEAM],
  });
  await useWorkspaceStore.getState().refresh();
  // Another account signed in after this list loaded.
  globalThis.window.electronAPI.setActiveWorkspaceScope = async (scope) => {
    calls.push(["scope", scope]);
    return { success: false, code: "ACCOUNT_CHANGED" };
  };

  await relocateLostWorkspaces(["team"]);

  assert.equal(names(calls).includes("relocate"), false);
});

test("the default workspace's own Private is never relocated", async (t) => {
  const { useWorkspaceStore, relocateLostWorkspaces, calls } = await loadPrivateNotesStore(t, {
    list: async () => [OWN, TEAM],
  });
  await useWorkspaceStore.getState().refresh();

  await relocateLostWorkspaces(["own"]);

  assert.equal(names(calls).includes("relocate"), false);
});

test("nothing is relocated before the store knows whose list it holds", async (t) => {
  const { relocateLostWorkspaces, calls } = await loadPrivateNotesStore(t, {
    list: async () => [OWN, TEAM],
  });

  await relocateLostWorkspaces(["team"]);

  assert.deepEqual(calls, []);
});

// Main's private rows: the default's (marked), one per other workspace, the signed-out stand-in.
const privateRow = (id, workspaceId, extra = {}) => ({
  id,
  kind: "private",
  workspace_id: workspaceId,
  account_id: "acct-1",
  is_default_private: 0,
  ...extra,
});
const relocationsOf = (calls) => calls.filter(([name]) => name === "relocate");

test("a workspace lost while signed out is relocated on the first list after signing in", async (t) => {
  // Signing out cleared the cached list, so only main's rows remember the workspace.
  const { useWorkspaceStore, calls } = await loadPrivateNotesStore(t, {
    list: async () => [OWN, TEAM],
    storage: { activeWorkspaceId: "team" },
    spaces: [
      privateRow(1, null, { account_id: null }),
      privateRow(2, "own", { is_default_private: 1 }),
      privateRow(3, "team"),
      privateRow(4, "lost"),
      // Main lists the signed-in account's rows; one of another account's never counts.
      privateRow(5, "elsewhere", { account_id: "acct-2" }),
      { id: 6, kind: "team", workspace_id: "gone", account_id: null },
    ],
  });

  await useWorkspaceStore.getState().refresh();

  assert.deepEqual(relocationsOf(calls), [["relocate", "lost", null, "acct-1"]]);
  // Main reads its rows with the new scope in place, and moves them after it.
  const relocateAt = calls.findIndex(([name]) => name === "relocate");
  assert.deepEqual(
    calls
      .slice(0, relocateAt)
      .filter(([name]) => name === "scope")
      .at(-1),
    ["scope", { activeWorkspaceId: "team", defaultWorkspaceId: "own", accountId: "acct-1" }]
  );
});

test("a workspace both the cached list and main's rows miss is relocated once", async (t) => {
  const { useWorkspaceStore, calls } = await loadPrivateNotesStore(t, {
    list: async () => [OWN, TEAM],
    storage: { [LIST_CACHE_KEY]: cacheFor("acct-1", [OWN, TEAM, LOST]) },
    spaces: [privateRow(2, "own", { is_default_private: 1 }), privateRow(4, "lost")],
  });

  await useWorkspaceStore.getState().refresh();

  assert.deepEqual(relocationsOf(calls), [["relocate", "lost", null, "acct-1"]]);
});

test("a relocation that threw is retried on the next successful list", async (t) => {
  const { useWorkspaceStore, calls } = await loadPrivateNotesStore(t, {
    list: async () => [OWN, TEAM],
    storage: { [LIST_CACHE_KEY]: cacheFor("acct-1", [OWN, TEAM, LOST]) },
    spaces: [privateRow(2, "own", { is_default_private: 1 }), privateRow(4, "lost")],
  });
  globalThis.__ws.relocateThrows = 1;

  await useWorkspaceStore.getState().refresh();
  // The cached list no longer has the workspace; main's row still does.
  await useWorkspaceStore.getState().refresh({ fresh: true });

  assert.deepEqual(relocationsOf(calls), [
    ["relocate", "lost", null, "acct-1"],
    ["relocate", "lost", null, "acct-1"],
  ]);
});

test("a failed or empty load relocates nothing, whatever rows main holds", async (t) => {
  const { useWorkspaceStore, calls } = await loadPrivateNotesStore(t, {
    list: async () => {
      throw new Error("offline");
    },
    storage: { [LIST_CACHE_KEY]: cacheFor("acct-1", [OWN, TEAM]) },
    spaces: [privateRow(2, "own", { is_default_private: 1 }), privateRow(4, "lost")],
  });

  await useWorkspaceStore.getState().refresh();
  globalThis.__ws.list = async () => [];
  await useWorkspaceStore.getState().refresh({ fresh: true });

  assert.deepEqual(relocationsOf(calls), []);
});

test("the default's own Private is never relocated by the row check", async (t) => {
  const { useWorkspaceStore, calls } = await loadPrivateNotesStore(t, {
    list: async () => [OWN, TEAM],
    spaces: [
      // The default's row, marked or not yet bound.
      privateRow(2, "own"),
      // A row main still reads as marked (these rows stand in for main's answer, which the
      // row check's own bind would have unmarked): main refuses to move one.
      privateRow(7, "previous-default", { is_default_private: 1 }),
      privateRow(3, "team"),
    ],
  });

  await useWorkspaceStore.getState().refresh();

  assert.deepEqual(relocationsOf(calls), []);
});

test("the row check waits until the default workspace is known", async (t) => {
  const { useWorkspaceStore, calls } = await loadPrivateNotesStore(t, {
    // No is_default and no Enterprise workspace yet: the default isn't made.
    list: async () => [TEAM],
    spaces: [privateRow(3, "team"), privateRow(4, "lost")],
  });

  await useWorkspaceStore.getState().refresh();

  assert.equal(useWorkspaceStore.getState().defaultWorkspaceId, null);
  assert.deepEqual(relocationsOf(calls), []);
});

test("the bridge sends the scope on startup and on every switch", async (t) => {
  const { useWorkspaceStore, vite, calls, changeDatabaseAccount } = await loadPrivateNotesStore(t, {
    list: async () => [TEAM, OWN],
  });
  const { startWorkspaceScopeBridge } = await vite.ssrLoadModule("/stores/workspaceScopeBridge.ts");
  const stop = startWorkspaceScopeBridge();
  t.after(stop);
  await flush();
  // Before the list loads the store names no account, so main refuses whatever it holds.
  assert.deepEqual(calls, [
    ["scope", { activeWorkspaceId: null, defaultWorkspaceId: null, accountId: null }],
  ]);

  calls.length = 0;
  await useWorkspaceStore.getState().refresh();
  await flush();
  // The refresh's own check of main's private rows sends the scope and binds too.
  assert.deepEqual(calls.filter(([name]) => name === "scope").at(-1), [
    "scope",
    { activeWorkspaceId: "own", defaultWorkspaceId: "own", accountId: "acct-1" },
  ]);
  const binds = calls.filter(([name]) => name === "bind");
  assert.ok(binds.length > 0);
  assert.ok(binds.every((bind) => bind[1] === "own" && bind[2] === "acct-1"));

  calls.length = 0;
  useWorkspaceStore.getState().setActiveWorkspaceId("team");
  await flush();
  assert.deepEqual(calls, [
    ["scope", { activeWorkspaceId: "team", defaultWorkspaceId: "own", accountId: "acct-1" }],
  ]);

  // Main forgets the workspace scope and the default's bind on every account change.
  calls.length = 0;
  changeDatabaseAccount({ accountId: "acct-1", visibleAccountId: "acct-1" });
  await flush();
  assert.deepEqual(calls, [
    ["scope", { activeWorkspaceId: "team", defaultWorkspaceId: "own", accountId: "acct-1" }],
    ["bind", "own", "acct-1"],
  ]);

  // Signed out (or another account): the store empties and says so.
  calls.length = 0;
  useWorkspaceStore.getState().resetForAccountChange();
  await flush();
  assert.deepEqual(calls, [
    ["scope", { activeWorkspaceId: null, defaultWorkspaceId: null, accountId: null }],
  ]);
});

test("the bridge leaves the sign-in claim to main", async (t) => {
  const { useWorkspaceStore, vite, calls, changeDatabaseAccount } = await loadPrivateNotesStore(t, {
    list: async () => [OWN],
  });
  const { startWorkspaceScopeBridge } = await vite.ssrLoadModule("/stores/workspaceScopeBridge.ts");
  t.after(startWorkspaceScopeBridge());
  await useWorkspaceStore.getState().refresh();
  changeDatabaseAccount({ accountId: "acct-1", visibleAccountId: "acct-1" });
  await flush();

  assert.equal(names(calls).includes("claim"), false);
});

test("a window follows another window's workspace switch", async (t) => {
  const { useWorkspaceStore, handleActiveWorkspaceStorage, storage } = await loadPrivateNotesStore(
    t,
    {
      list: async () => [OWN, TEAM],
      storage: { activeWorkspaceId: "own" },
    }
  );
  await useWorkspaceStore.getState().refresh();

  storage.setItem("activeWorkspaceId", "team");
  handleActiveWorkspaceStorage({ key: "activeWorkspaceId", newValue: "team" });

  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, "team");
});

test("a refresh follows another window's workspace choice it hasn't heard of yet", async (t) => {
  const { useWorkspaceStore, storage } = await loadPrivateNotesStore(t, {
    list: async () => [OWN, TEAM],
  });
  await useWorkspaceStore.getState().refresh();

  // Another window switched to "team"; its storage events haven't arrived here yet.
  storage.setItem("activeWorkspaceId", "team");
  await useWorkspaceStore.getState().refresh({ fresh: true });

  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, "team");
});

test("Retry asks for the default workspace again after this session's answer", async (t) => {
  const { useWorkspaceStore, ensureDefaultWorkspace } = await loadPrivateNotesStore(t, {
    list: async () => [],
    ensureDefault: async () => null,
  });
  await useWorkspaceStore.getState().refresh();

  await ensureDefaultWorkspace("Ada's workspace");
  await ensureDefaultWorkspace("Ada's workspace");
  assert.equal(globalThis.__ws.ensureCalls.length, 1, "asked once per session on its own");

  globalThis.__ws.ensureDefault = async () => {
    globalThis.__ws.list = async () => [OWN];
    return OWN;
  };
  await ensureDefaultWorkspace("Ada's workspace", { again: true });

  assert.equal(globalThis.__ws.ensureCalls.length, 2);
  assert.equal(useWorkspaceStore.getState().defaultWorkspaceId, "own");
});

test("losing the Enterprise workspace that stood in as the default asks for a default again", async (t) => {
  const { useWorkspaceStore, ensureDefaultWorkspace } = await loadPrivateNotesStore(t, {
    list: async () => [TEAM, ENTERPRISE],
    ensureDefault: async () => null,
  });
  await useWorkspaceStore.getState().refresh();
  await ensureDefaultWorkspace("Ada's workspace");
  assert.equal(useWorkspaceStore.getState().defaultWorkspaceId, "corp");

  // Left or deleted: the store forgets it, and the hook asks again once the list changes.
  useWorkspaceStore.getState().forgetWorkspace("corp");
  await ensureDefaultWorkspace("Ada's workspace");
  assert.equal(globalThis.__ws.ensureCalls.length, 2);

  // Listed again, the answer given since still holds.
  globalThis.__ws.list = async () => [TEAM, ENTERPRISE];
  await useWorkspaceStore.getState().refresh({ fresh: true });
  await ensureDefaultWorkspace("Ada's workspace");
  assert.equal(globalThis.__ws.ensureCalls.length, 2);

  // Gone from a list read elsewhere (another device, an admin): asked again.
  globalThis.__ws.list = async () => [TEAM];
  await useWorkspaceStore.getState().refresh({ fresh: true });
  await ensureDefaultWorkspace("Ada's workspace");
  assert.equal(globalThis.__ws.ensureCalls.length, 3);
});

test("an answer to a request sent before the stand-in was lost isn't this session's answer", async (t) => {
  const { useWorkspaceStore, ensureDefaultWorkspace } = await loadPrivateNotesStore(t, {
    list: async () => [TEAM, ENTERPRISE],
  });
  await useWorkspaceStore.getState().refresh();
  let answer;
  globalThis.__ws.ensureDefault = () => new Promise((resolve) => (answer = resolve));

  const inFlight = ensureDefaultWorkspace("Ada's workspace");
  useWorkspaceStore.getState().forgetWorkspace("corp");
  answer(null);
  await inFlight;
  globalThis.__ws.ensureDefault = async () => null;
  await ensureDefaultWorkspace("Ada's workspace");

  assert.equal(globalThis.__ws.ensureCalls.length, 2);
});

test("the row check binds the default before it reads main's rows", async (t) => {
  const { useWorkspaceStore, calls } = await loadPrivateNotesStore(t, {
    list: async () => [OWN, TEAM],
  });

  await useWorkspaceStore.getState().refresh();

  // A Private that was the default until now loses its mark in the bind, so it can move.
  assert.deepEqual(names(calls), ["scope", "bind", "spaces"]);
  assert.deepEqual(calls[1], ["bind", "own", "acct-1"]);
});

test("the Enterprise stand-in's private notes reach the new default's Private in the same session", async (t) => {
  const { createDb } = require("../helpers/harness/db.js");
  const db = createDb(t);
  if (!db) return;
  db.setActiveAccountId("acct-1");
  // Main's handlers, account guard included, over a real database.
  const refused = { success: false, code: "ACCOUNT_CHANGED" };
  const forOtherAccount = (accountId) =>
    accountId !== undefined && accountId !== db.activeAccountId;
  const main = {
    setActiveWorkspaceScope: async ({ accountId, ...scope }) => {
      if (forOtherAccount(accountId)) return refused;
      db.setActiveWorkspaceScope(scope);
      return { success: true };
    },
    bindDefaultPrivateSpace: async (workspaceId, accountId) => {
      if (forOtherAccount(accountId)) return refused;
      db.bindDefaultPrivateSpace(workspaceId);
      return { success: true };
    },
    relocatePrivateSpace: async (from, to, accountId) => {
      if (forOtherAccount(accountId)) return refused;
      return { success: true, ...db.relocatePrivateSpace(from, to) };
    },
    getSpaces: async () => db.getSpaces(),
  };
  const MINE = {
    id: "mine",
    name: "Ada's workspace",
    plan: "free",
    status: "active",
    is_default: true,
  };
  const { useWorkspaceStore, ensureDefaultWorkspace, relocateLostWorkspaces, vite } =
    await loadPrivateNotesStore(t, {
      // An Enterprise member: the server makes no default of their own.
      list: async () => [ENTERPRISE],
      ensureDefault: async () => null,
      main,
    });
  const { startWorkspaceScopeBridge } = await vite.ssrLoadModule("/stores/workspaceScopeBridge.ts");
  const { spacesInWorkspaceScope } = await vite.ssrLoadModule("/lib/workspaceSelection.ts");
  t.after(startWorkspaceScopeBridge());
  await useWorkspaceStore.getState().refresh();
  await ensureDefaultWorkspace("Ada's workspace");
  await flush();
  const corpPrivate = db.getDefaultPrivateSpaceId();
  const note = db.saveNote("Corp idea", "").note;
  assert.equal(note.space_id, corpPrivate, "written in the stand-in's Private");

  // The user leaves the Enterprise workspace (workspaceActions' afterLosingWorkspace).
  useWorkspaceStore.getState().forgetWorkspace("corp");
  await relocateLostWorkspaces(["corp"]);
  globalThis.__ws.list = async () => [];
  await useWorkspaceStore.getState().refresh({ fresh: true });
  // The list changed, so useEnsureDefaultWorkspace asks again; the server makes their own now.
  globalThis.__ws.ensureDefault = async () => {
    globalThis.__ws.list = async () => [MINE];
    return MINE;
  };
  await ensureDefaultWorkspace("Ada's workspace");
  await flush();

  const state = useWorkspaceStore.getState();
  assert.equal(state.defaultWorkspaceId, "mine");
  assert.equal(state.activeWorkspaceId, "mine");
  const minePrivate = db.getPrivateSpaceId("mine");
  assert.equal(db.getNote(note.id).space_id, minePrivate, "the note moved to the new default");
  const visible = spacesInWorkspaceScope(
    await db.getSpaces(),
    state.activeWorkspaceId,
    state.workspaces,
    state.defaultWorkspaceId
  );
  assert.ok(
    visible.some((space) => space.id === minePrivate),
    "the new default's Private shows"
  );
  assert.ok(
    !(await db.getSpaces()).some((space) => space.id === corpPrivate),
    "the stand-in's Private is retired"
  );
});

// D45: what the app picked by itself (no saved choice) yields to the account's own default once a
// list in this session first shows it; a choice the user made never does.
const SOURCE_KEY = "activeWorkspaceSource";
const OTHER_TEAM = { id: "other", plan: "business", status: "active", is_default: false };

test("a first sign-in's automatic pick yields to the default the server makes", async (t) => {
  // An invited account: the first list holds only the team; the default arrives after ensure.
  const { useWorkspaceStore, ensureDefaultWorkspace, storage } = await loadPrivateNotesStore(t, {
    list: async () => [TEAM],
    ensureDefault: async () => {
      globalThis.__ws.list = async () => [TEAM, OWN];
      return OWN;
    },
  });

  await useWorkspaceStore.getState().refresh();
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, "team");

  await ensureDefaultWorkspace("Ada's workspace");

  const state = useWorkspaceStore.getState();
  assert.equal(state.defaultWorkspaceId, "own");
  assert.equal(state.activeWorkspaceId, "own");
  assert.equal(storage.getItem("activeWorkspaceId"), "own");
  assert.equal(storage.getItem(SOURCE_KEY), "auto");
});

test("a switch the user made before the default arrived is kept", async (t) => {
  let answerEnsure;
  const { useWorkspaceStore, ensureDefaultWorkspace, storage } = await loadPrivateNotesStore(t, {
    list: async () => [OTHER_TEAM, TEAM],
    ensureDefault: () =>
      new Promise((resolve) => {
        answerEnsure = () => {
          globalThis.__ws.list = async () => [OTHER_TEAM, TEAM, OWN];
          resolve(OWN);
        };
      }),
  });
  await useWorkspaceStore.getState().refresh();
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, "other");

  // The switcher, while the default is still being made.
  const ensured = ensureDefaultWorkspace("Ada's workspace");
  useWorkspaceStore.getState().setActiveWorkspaceId("team");
  answerEnsure();
  await ensured;

  const state = useWorkspaceStore.getState();
  assert.equal(state.defaultWorkspaceId, "own");
  assert.equal(state.activeWorkspaceId, "team");
  assert.equal(storage.getItem("activeWorkspaceId"), "team");
});

for (const { label, source, expected } of [
  { label: "a choice the user saved in an earlier session", source: "user", expected: "team" },
  // Saved by a build that recorded no source: counted as the user's, so nobody moves.
  { label: "a choice an older build saved without a source", source: null, expected: "team" },
  // Picked while the default didn't exist yet (ensure kept failing that session).
  { label: "an automatic pick saved before the default existed", source: "auto", expected: "own" },
]) {
  test(`${label} meets the default on the first list: ${expected}`, async (t) => {
    const { useWorkspaceStore, storage } = await loadPrivateNotesStore(t, {
      list: async () => [TEAM, OWN],
      storage: { activeWorkspaceId: "team", ...(source ? { [SOURCE_KEY]: source } : {}) },
    });

    await useWorkspaceStore.getState().refresh();

    assert.equal(useWorkspaceStore.getState().defaultWorkspaceId, "own");
    assert.equal(useWorkspaceStore.getState().activeWorkspaceId, expected);
    assert.equal(storage.getItem("activeWorkspaceId"), expected);
  });
}

test("a saved Personal choice still reaches the default made after the first list", async (t) => {
  // An older build saved both; Personal meant the account's own notes, so its default.
  const { useWorkspaceStore, ensureDefaultWorkspace, storage } = await loadPrivateNotesStore(t, {
    list: async () => [TEAM],
    storage: { workspacePersonalSelected: "true", activeWorkspaceId: "team" },
    ensureDefault: async () => {
      globalThis.__ws.list = async () => [TEAM, OWN];
      return OWN;
    },
  });
  await useWorkspaceStore.getState().refresh();
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, "team");

  await ensureDefaultWorkspace("Ada's workspace");

  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, "own");
  assert.equal(storage.getItem("activeWorkspaceId"), "own");
});

test("an automatically picked Enterprise workspace stays when the default arrives (D17)", async (t) => {
  const { useWorkspaceStore, ensureDefaultWorkspace } = await loadPrivateNotesStore(t, {
    list: async () => [TEAM, ENTERPRISE],
    ensureDefault: async () => {
      globalThis.__ws.list = async () => [TEAM, ENTERPRISE, OWN];
      return OWN;
    },
  });
  await useWorkspaceStore.getState().refresh();
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, "corp");

  await ensureDefaultWorkspace("Ada's workspace");

  assert.equal(useWorkspaceStore.getState().defaultWorkspaceId, "own");
  assert.equal(useWorkspaceStore.getState().activeWorkspaceId, "corp");
});

test("main hears the default's scope once a first sign-in's pick yields to it", async (t) => {
  const { useWorkspaceStore, ensureDefaultWorkspace, vite, calls } = await loadPrivateNotesStore(
    t,
    {
      list: async () => [TEAM],
      ensureDefault: async () => {
        globalThis.__ws.list = async () => [TEAM, OWN];
        return OWN;
      },
    }
  );
  const { startWorkspaceScopeBridge } = await vite.ssrLoadModule("/stores/workspaceScopeBridge.ts");
  t.after(startWorkspaceScopeBridge());
  await useWorkspaceStore.getState().refresh();
  await flush();
  assert.deepEqual(calls.filter(([name]) => name === "scope").at(-1), [
    "scope",
    { activeWorkspaceId: "team", defaultWorkspaceId: null, accountId: "acct-1" },
  ]);

  calls.length = 0;
  await ensureDefaultWorkspace("Ada's workspace");
  await flush();

  assert.deepEqual(calls.filter(([name]) => name === "scope").at(-1), [
    "scope",
    { activeWorkspaceId: "own", defaultWorkspaceId: "own", accountId: "acct-1" },
  ]);
  assert.ok(calls.some((call) => call[0] === "bind" && call[1] === "own" && call[2] === "acct-1"));
});
