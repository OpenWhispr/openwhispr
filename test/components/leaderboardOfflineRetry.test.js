const test = require("node:test");
const assert = require("node:assert/strict");
const { act, createElement } = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");
const en = require("../../src/locales/en/translation.json");

test("the offline leaderboard Retry asks auth to confirm the session", async (t) => {
  let root;
  t.after(() => act(() => root?.unmount()));
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const calls = { auth: 0, access: 0, signIn: 0 };
  globalThis.__leaderboardRetry = calls;
  t.after(() => delete globalThis.__leaderboardRetry);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-leaderboard-retry-",
    mockModules: {
      "/hooks/useAuth": `
        export const useAuth = () => ({
          isLoaded: true,
          isSignedIn: true,
          isOfflineAccount: true,
          user: { id: "user-a" },
          refetch: async () => { globalThis.__leaderboardRetry.auth += 1; },
        });
      `,
      "/hooks/useSettings": "export const useSettings = () => ({ dataRetentionEnabled: true });",
      "/hooks/useLeaderboardParticipation": `
        export const useLeaderboardParticipation = () => ({
          enabled: false, ready: true, error: null, updating: false, leavePending: false,
        });
      `,
      "/lib/auth": "export const signInWithSSO = async () => ({});",
      "/lib/authRequestContext": "export const getValidatedAuthGeneration = () => null;",
      "/stores/workspaceStore": `
        const state = { loaded: true, workspaces: [] };
        export const useWorkspaceStore = (select) => select(state);
      `,
      "/stores/policyStore": `
        export const usePolicyStore = (select) => select({ status: "unmanaged", managed: false });
      `,
      "/services/LeaderboardService": `
        export const LeaderboardService = {
          getAccess: async () => { globalThis.__leaderboardRetry.access += 1; },
        };
      `,
      "/ui/useToast": "export const useToast = () => ({ toast() {} });",
    },
  });
  const { default: LeaderboardView } = await vite.ssrLoadModule("/components/LeaderboardView.tsx");
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(LeaderboardView, {
        enableInsightsSync: async () => true,
        insightsSyncEnabled: false,
        onSignIn: () => {
          calls.signIn += 1;
        },
        syncAllowedByPolicy: true,
      })
    )
  );
  const retry = findElement(
    container,
    (node) => node.tagName === "BUTTON" && node.textContent === en.insights.leaderboard.retry
  );
  assert.ok(retry, `Retry button missing: ${container.textContent}`);
  await act(async () => retry.dispatchEvent({ type: "click", bubbles: true, button: 0 }));

  assert.deepEqual(calls, { auth: 1, access: 0, signIn: 0 });
});
