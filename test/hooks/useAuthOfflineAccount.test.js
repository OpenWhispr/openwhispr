const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const SESSION_URL = "https://auth.openwhispr.test/api/auth/get-session";
const PROFILE_KEY = "openwhispr:accountProfile";
const USER_A = { id: "user-a", name: "Ada", email: "ada@example.com", image: null };
const USER_B = { id: "user-b", name: "Bo", email: "bo@example.com", image: null };

// Local state as a previous, validated launch of user-a left it.
const reconciledFor = (userId, profileUser = USER_A) => ({
  "openwhispr:accountScopeUserId": userId,
  "openwhispr:accountScopeValidated": "true",
  isSignedIn: "true",
  [PROFILE_KEY]: JSON.stringify({ ...profileUser, emailVerified: true, validatedAt: Date.now() }),
});

async function mountUseAuth(t, { initialStorage }) {
  // Registered first: the root must unmount while the browser globals exist.
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const calls = {
    fetchPolicy: [],
    setActiveAccountScope: [],
    purge: 0,
    workspaceRefresh: 0,
    setIsSignedIn: [],
  };
  const token = { token: "token-a", generation: 5 };
  const binding = { accountId: "user-a", token: "token-a" };
  const sessionListeners = new Set();
  globalThis.__authTest = {
    session: { data: null, isPending: true, error: null, refetch: async () => null },
    subscribe(listener) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    calls,
  };

  const { storage } = installBrowserGlobals(t, {
    initialStorage,
    window: {
      location: { origin: "https://desktop.openwhispr.test", search: "?panel=true" },
      electronAPI: {
        authGetTokenState: async () => ({ ...token }),
        getActiveAccountScope: async () =>
          token.token === binding.token
            ? { accountId: binding.accountId, authGeneration: token.generation }
            : null,
        setActiveAccountScope: async (accountId, generation) => {
          calls.setActiveAccountScope.push([accountId, generation]);
          return { success: true };
        },
      },
    },
  });
  const container = installHookDom(t);
  t.after(() => {
    delete globalThis.__authTest;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-use-auth-offline-",
    mockModules: {
      "/lib/auth": `
        import { useSyncExternalStore } from "react";
        const state = globalThis.__authTest;
        export const authClient = {
          useSession: () => useSyncExternalStore(state.subscribe, () => state.session),
        };
        export const isWithinGracePeriod = () => false;
        export const getGracePeriodRemainingMs = () => 0;
      `,
      "/utils/logger": "export default { debug() {}, error() {}, warn() {}, info() {} };",
      "/stores/settingsStore": `
        const calls = globalThis.__authTest.calls;
        export const useSettingsStore = { getState: () => ({
          setIsSignedIn: (value) => calls.setIsSignedIn.push(value),
          setInsightsSyncEnabled() {},
        }) };
      `,
      "/stores/policyStore": `
        const calls = globalThis.__authTest.calls;
        export const usePolicyStore = { getState: () => ({
          fetchPolicy: async (accountId, generation) => calls.fetchPolicy.push([accountId, generation]),
          suspendPolicy() {},
          clearPolicy() {},
        }) };
      `,
      "/stores/enterpriseIdentityStore":
        "export const useEnterpriseIdentityStore = { getState: () => ({ clear() {} }) };",
      "/stores/leaderboardParticipationStore":
        "export const useLeaderboardParticipationStore = { getState: () => ({ reset() {} }) };",
      "/services/SyncService.js": `
        const calls = globalThis.__authTest.calls;
        export const syncService = {
          purgeTeamSpacesForSignOut: async () => { calls.purge += 1; },
          verifyTeamSpacesForAccount: async () => 0,
        };
      `,
      "/lib/spaceRosterCache": "export const invalidateSpaceRoster = () => {};",
      "/stores/noteStore": "export const resetForAccountChange = () => {};",
      "/stores/workspaceStore": `
        const calls = globalThis.__authTest.calls;
        export const useWorkspaceStore = { getState: () => ({
          refresh: async () => { calls.workspaceRefresh += 1; },
          resetForAccountChange() {},
        }) };
        export const refreshManagedEnterpriseIdentity = () => {};
      `,
    },
  });
  const { useAuth } = await vite.ssrLoadModule("/hooks/useAuth.ts");
  const authContext = await vite.ssrLoadModule("/lib/authRequestContext.ts");
  authContext.resetAuthRequestContextForTests();

  let result = null;
  function Harness() {
    result = useAuth();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));

  const settle = async () => {
    for (let i = 0; i < 10; i += 1) {
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };
  const setSession = async (session) => {
    await React.act(async () => {
      globalThis.__authTest.session = { refetch: async () => null, ...session };
      sessionListeners.forEach((listener) => listener());
    });
    await settle();
  };
  const sessionRequest = () => ({
    url: SESSION_URL,
    headers: new Headers({ Authorization: `Bearer ${token.token}` }),
    openWhisprAuthGeneration: token.generation,
  });
  // The launch's get-session cannot reach the server.
  const goOffline = async () => {
    await React.act(() =>
      authContext.handleAuthRequestError({
        request: sessionRequest(),
        response: new Response("", { status: 503 }),
      })
    );
    await setSession({ data: null, isPending: false, error: new Error("unreachable") });
  };
  const answer = async (user) => {
    await React.act(() =>
      authContext.handleAuthRequestSuccess({
        data: user ? { user, session: { id: "s" } } : null,
        response: new Response("{}", { status: 200 }),
        request: sessionRequest(),
      })
    );
    await setSession({
      data: user ? { user, session: { id: "s" } } : null,
      isPending: false,
      error: null,
    });
  };
  const reject = async () => {
    await React.act(() =>
      authContext.handleAuthRequestError({
        request: sessionRequest(),
        response: new Response("", { status: 401 }),
      })
    );
    await setSession({ data: null, isPending: false, error: { status: 401 } });
  };

  return {
    calls,
    storage,
    authContext,
    goOffline,
    setSession,
    answer,
    reject,
    result: () => result,
  };
}

test("an offline launch presents the last validated account read-only", async (t) => {
  const auth = await mountUseAuth(t, { initialStorage: reconciledFor("user-a") });
  await auth.goOffline();

  const result = auth.result();
  assert.equal(result.isSignedIn, true);
  assert.equal(result.isLoaded, true);
  assert.equal(result.isOfflineAccount, true);
  assert.equal(result.session, null);
  assert.equal(result.user.id, "user-a");
  assert.equal(result.user.email, "ada@example.com");
  // Policy, managed config and the workspace list load from caches for user-a…
  assert.deepEqual(auth.calls.fetchPolicy, [["user-a", 5]]);
  assert.equal(auth.calls.workspaceRefresh, 1);
  // …while reconciliation and sync stay fenced until a real get-session.
  assert.deepEqual(auth.calls.setActiveAccountScope, []);
  assert.deepEqual(auth.calls.setIsSignedIn, []);
  assert.equal(auth.authContext.getValidatedAuthGeneration(), null);
});

test("a session refetch while offline keeps presenting the account", async (t) => {
  const auth = await mountUseAuth(t, { initialStorage: reconciledFor("user-a") });
  await auth.goOffline();

  // Better Auth marks every refetch pending while it holds no session.
  await auth.setSession({ data: null, isPending: true, error: null });
  assert.equal(auth.result().isSignedIn, true);
  assert.equal(auth.result().isLoaded, true);
  assert.equal(auth.result().user.id, "user-a");

  await auth.goOffline();
  assert.equal(auth.result().isOfflineAccount, true);
});

test("an offline launch never presents a scope reconciled for another account", async (t) => {
  const auth = await mountUseAuth(t, { initialStorage: reconciledFor("user-b", USER_B) });
  await auth.goOffline();

  assert.equal(auth.result().isSignedIn, false);
  assert.equal(auth.result().user, null);
  assert.deepEqual(auth.calls.fetchPolicy, []);
  assert.equal(auth.calls.workspaceRefresh, 0);
});

test("an offline launch with a pending purge stays a guest", async (t) => {
  const auth = await mountUseAuth(t, {
    initialStorage: { ...reconciledFor("user-a"), "openwhispr:accountScopePurgeRequired": "true" },
  });
  await auth.goOffline();

  assert.equal(auth.result().isSignedIn, false);
  assert.deepEqual(auth.calls.fetchPolicy, []);
});

test("back online, the same account is confirmed without a purge", async (t) => {
  const auth = await mountUseAuth(t, { initialStorage: reconciledFor("user-a") });
  await auth.goOffline();
  await auth.answer({ ...USER_A, name: "Ada L." });

  const result = auth.result();
  assert.equal(result.isSignedIn, true);
  assert.equal(result.isOfflineAccount, false);
  assert.equal(auth.calls.purge, 0);
  assert.ok(auth.calls.setActiveAccountScope.length > 0);
  for (const call of auth.calls.setActiveAccountScope) assert.deepEqual(call, ["user-a", 5]);
  assert.equal(auth.authContext.getValidatedAuthGeneration(), 5);
  assert.equal(JSON.parse(auth.storage.getItem(PROFILE_KEY)).name, "Ada L.");
});

test("back online, a different account purges the offline account's caches", async (t) => {
  const auth = await mountUseAuth(t, { initialStorage: reconciledFor("user-a") });
  await auth.goOffline();
  await auth.answer(USER_B);

  assert.equal(auth.calls.purge, 1);
  assert.equal(auth.storage.getItem("openwhispr:accountScopeUserId"), "user-b");
  assert.equal(auth.result().user.id, "user-b");
  assert.equal(JSON.parse(auth.storage.getItem(PROFILE_KEY)).id, "user-b");
});

test("back online, a revoked session (no user) purges as a sign-out", async (t) => {
  const auth = await mountUseAuth(t, { initialStorage: reconciledFor("user-a") });
  await auth.goOffline();
  await auth.answer(null);

  assert.equal(auth.calls.purge, 1);
  assert.equal(auth.result().isSignedIn, false);
  assert.equal(auth.storage.getItem(PROFILE_KEY), null);
});

test("back online, a 401 drops to guest and the credential stays unpresented", async (t) => {
  const auth = await mountUseAuth(t, { initialStorage: reconciledFor("user-a") });
  await auth.goOffline();
  await auth.reject();

  assert.equal(auth.result().isSignedIn, false);
  assert.equal(auth.result().isOfflineAccount, false);
  assert.equal(auth.authContext.getOfflineAccount(), null);
  assert.deepEqual(auth.calls.setActiveAccountScope, []);
  assert.equal(auth.storage.getItem(PROFILE_KEY), null);
});
