const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("leaderboard participation is account-scoped across auth changes", async (t) => {
  let root = null;
  let hook;
  t.after(() => {
    for (const key of [
      "__participationAuthGeneration",
      "__participationJoinMode",
      "__participationJoins",
      "__participationLeaves",
      "__participationPendingLeaves",
      "__participationQueuedLeaves",
      "__participationRefreshes",
      "__participationResets",
      "__participationSessionUserId",
    ]) {
      delete globalThis[key];
    }
  });

  globalThis.__participationAuthGeneration = 7;
  globalThis.__participationJoinMode = "success";
  globalThis.__participationJoins = [];
  globalThis.__participationLeaves = [];
  globalThis.__participationPendingLeaves = [];
  globalThis.__participationQueuedLeaves = [];
  globalThis.__participationRefreshes = [];
  globalThis.__participationResets = 0;
  globalThis.__participationSessionUserId = "account-1";

  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-leaderboard-participation-hook-",
    mockModules: {
      "./useAuth": `
        export const useAuth = () => ({
          isLoaded: true,
          isSignedIn: true,
          user: { id: "account-1" }
        });
      `,
      "/lib/authRequestContext": `
        export const getAuthRequestContextSnapshot = () => ({
          sessionUserId: globalThis.__participationSessionUserId
        });
        export const getValidatedAuthGeneration = () =>
          globalThis.__participationAuthGeneration;
      `,
      "/lib/pendingLeaderboardLeave": `
        export const writePendingLeaderboardLeave = (userId) => {
          globalThis.__participationPendingLeaves.push(userId);
        };
      `,
      "/stores/leaderboardParticipationStore": `
        const state = {
          enabled: false,
          ready: true,
          error: null,
          updating: false,
          refresh: async (context) => {
            globalThis.__participationRefreshes.push(context);
          },
          reset: () => { globalThis.__participationResets += 1; },
          join: async (context) => {
            globalThis.__participationJoins.push(context);
            if (globalThis.__participationJoinMode === "auth-change-success") {
              globalThis.__participationAuthGeneration += 1;
            }
            return globalThis.__participationJoinMode !== "failure";
          },
          leave: async (context) => {
            globalThis.__participationLeaves.push(context);
            return true;
          },
          queueLeave: (userId) => {
            globalThis.__participationQueuedLeaves.push(userId);
          }
        };
        export const useLeaderboardParticipationStore = (selector) => selector(state);
        useLeaderboardParticipationStore.getState = () => state;
      `,
    },
  });
  const { useLeaderboardParticipation } = await vite.ssrLoadModule(
    "/hooks/useLeaderboardParticipation.ts"
  );

  function Harness() {
    hook = useLeaderboardParticipation();
    return null;
  }

  const render = async () => {
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });
  };
  const invoke = async (action) => {
    let result;
    await React.act(async () => {
      result = await action();
    });
    return result;
  };

  root = createRoot(container);
  await render();
  assert.deepEqual(globalThis.__participationRefreshes, [
    { userId: "account-1", authGeneration: 7 },
  ]);

  assert.equal(await invoke(hook.join), true);
  assert.deepEqual(globalThis.__participationJoins.at(-1), {
    userId: "account-1",
    authGeneration: 7,
  });

  globalThis.__participationJoinMode = "failure";
  assert.equal(await invoke(hook.join), false);
  assert.deepEqual(globalThis.__participationPendingLeaves, []);

  globalThis.__participationJoinMode = "auth-change-success";
  assert.equal(await invoke(hook.join), true);
  assert.deepEqual(globalThis.__participationPendingLeaves, []);

  globalThis.__participationAuthGeneration = null;
  globalThis.__participationJoinMode = "success";
  await render();
  assert.equal(globalThis.__participationResets, 1);
  assert.equal(await invoke(hook.leave), false);
  assert.deepEqual(globalThis.__participationQueuedLeaves, ["account-1"]);

  globalThis.__participationSessionUserId = "account-2";
  assert.equal(await invoke(hook.leave), false);
  assert.deepEqual(globalThis.__participationPendingLeaves, ["account-1"]);

  globalThis.__participationSessionUserId = "account-1";
  globalThis.__participationAuthGeneration = 8;
  await render();
  assert.equal(await invoke(hook.leave), true);
  assert.deepEqual(globalThis.__participationLeaves, [{ userId: "account-1", authGeneration: 8 }]);

  await React.act(async () => root.unmount());
  root = null;
});

// Settings opens often, and only Privacy & Data shows the answer. A recent
// answer for the same account is reused; anything else is read again.
test("leaderboard participation skips a mount read only for a recent same-account answer", async (t) => {
  let root = null;
  t.after(() => {
    delete globalThis.__freshParticipation;
  });
  globalThis.__freshParticipation = {
    authGeneration: 7,
    resets: 0,
    refreshes: 0,
    answeredUserId: null,
    answeredAt: 0,
    leavePending: false,
    error: null,
  };

  installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-leaderboard-participation-fresh-",
    mockModules: {
      "./useAuth": `
        export const useAuth = () => ({ isLoaded: true, isSignedIn: true, user: { id: "account-1" } });
      `,
      "/lib/authRequestContext": `
        export const getAuthRequestContextSnapshot = () => ({ sessionUserId: "account-1" });
        export const getValidatedAuthGeneration = () => globalThis.__freshParticipation.authGeneration;
      `,
      "/lib/pendingLeaderboardLeave": `export const writePendingLeaderboardLeave = () => {};`,
      "/stores/leaderboardParticipationStore": `
        const state = {
          enabled: true, ready: true, updating: false,
          get answeredUserId() { return globalThis.__freshParticipation.answeredUserId; },
          get answeredAt() { return globalThis.__freshParticipation.answeredAt; },
          get leavePending() { return globalThis.__freshParticipation.leavePending; },
          get error() { return globalThis.__freshParticipation.error; },
          refresh: async () => { globalThis.__freshParticipation.refreshes += 1; },
          reset: () => { globalThis.__freshParticipation.resets += 1; },
        };
        export const useLeaderboardParticipationStore = (selector) => selector(state);
        useLeaderboardParticipationStore.getState = () => state;
      `,
    },
  });
  const { useLeaderboardParticipation } = await vite.ssrLoadModule(
    "/hooks/useLeaderboardParticipation.ts"
  );
  const mount = async (options) => {
    function Harness() {
      useLeaderboardParticipation(options);
      return null;
    }
    root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });
    await React.act(async () => root.unmount());
  };
  const fresh = globalThis.__freshParticipation;

  await mount();
  assert.equal(fresh.refreshes, 1, "no answer yet");

  Object.assign(fresh, { answeredUserId: "account-1", answeredAt: Date.now() });
  await mount();
  assert.equal(fresh.refreshes, 1, "a recent answer for this account is reused");

  fresh.answeredAt = Date.now() - 5 * 60 * 1000;
  await mount();
  assert.equal(fresh.refreshes, 2, "a five-minute-old answer is read again");

  Object.assign(fresh, { answeredUserId: "account-2", answeredAt: Date.now() });
  await mount();
  assert.equal(fresh.refreshes, 3, "another account's answer never counts");

  Object.assign(fresh, { answeredUserId: "account-1", answeredAt: Date.now(), leavePending: true });
  await mount();
  assert.equal(fresh.refreshes, 4, "an owed leave is delivered by the read, so it never waits");

  Object.assign(fresh, { leavePending: false, error: "write" });
  await mount();
  assert.equal(fresh.refreshes, 5, "an error is cleared by the read, so it never waits");

  Object.assign(fresh, { answeredUserId: "account-1", answeredAt: Date.now(), error: null });
  fresh.authGeneration = null;
  await mount();
  assert.equal(fresh.resets, 1, "an unvalidated session drops even a recent answer");
  fresh.authGeneration = 7;

  Object.assign(fresh, { answeredUserId: null });
  await mount({ autoRefresh: false });
  assert.equal(fresh.refreshes, 5, "a surface that isn't showing the answer reads nothing");
});
