const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("leaderboard participation is account-scoped and compensates stale joins", async (t) => {
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
  assert.equal(await invoke(hook.join), false);
  assert.deepEqual(globalThis.__participationPendingLeaves, ["account-1"]);

  globalThis.__participationAuthGeneration = null;
  globalThis.__participationJoinMode = "success";
  await render();
  assert.equal(globalThis.__participationResets, 1);
  assert.equal(await invoke(hook.leave), false);
  assert.deepEqual(globalThis.__participationQueuedLeaves, ["account-1"]);

  globalThis.__participationSessionUserId = "account-2";
  assert.equal(await invoke(hook.leave), false);
  assert.deepEqual(globalThis.__participationPendingLeaves, ["account-1", "account-1"]);

  globalThis.__participationSessionUserId = "account-1";
  globalThis.__participationAuthGeneration = 8;
  await render();
  assert.equal(await invoke(hook.leave), true);
  assert.deepEqual(globalThis.__participationLeaves, [{ userId: "account-1", authGeneration: 8 }]);

  await React.act(async () => root.unmount());
  root = null;
});
