const test = require("node:test");
const assert = require("node:assert/strict");
const { act, createElement } = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");
const en = require("../../src/locales/en/translation.json");

test("leaderboard Retry reloads online and confirms offline sessions with or without access", async (t) => {
  let root;
  t.after(() => act(() => root?.unmount()));
  installBrowserGlobals(t, { window: { clearInterval() {} } });
  const container = installInteractiveDom(t);
  const calls = { auth: 0, access: 0, board: 0, signIn: 0 };
  const state = { offline: true, calls };
  globalThis.__leaderboardRetry = state;
  t.after(() => delete globalThis.__leaderboardRetry);
  t.mock.method(console, "error", () => {});
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-leaderboard-retry-",
    mockModules: {
      "/useAuth": `
        export const useAuth = () => ({
          isLoaded: true,
          isSignedIn: true,
          isOfflineAccount: globalThis.__leaderboardRetry.offline,
          user: { id: "user-a" },
          refetch: async () => { globalThis.__leaderboardRetry.calls.auth += 1; },
        });
      `,
      "/hooks/useSettings": "export const useSettings = () => ({ dataRetentionEnabled: true });",
      "/lib/auth": "export const signInWithSSO = async () => ({});",
      "/lib/authRequestContext": `
        export const getValidatedAuthGeneration = () => globalThis.__leaderboardRetry.offline ? null : 1;
        export const getAuthRequestContextSnapshot = () => ({ sessionUserId: "user-a" });
      `,
      "/stores/workspaceStore": `
        const state = { loaded: true, workspaces: [] };
        export const useWorkspaceStore = (select) => select(state);
      `,
      "/stores/policyStore": `
        export const usePolicyStore = (select) => select({ status: "unmanaged", managed: false });
      `,
      "/services/LeaderboardService": `
        export const LeaderboardService = {
          flushPendingLeave: async () => false,
          getParticipation: async () => ({ enabled: true, configured: true }),
          getAccess: async () => {
            globalThis.__leaderboardRetry.calls.access += 1;
            return {
              state: "ready", domain: "example.com", colleagueCount: 2,
              invitation: null, joinableWorkspace: null,
              scopes: [{
                key: "domain:example.com", kind: "domain", id: "example.com",
                name: "Example", memberCount: 2, state: "ready", role: null,
              }],
            };
          },
          getLeaderboard: async () => {
            globalThis.__leaderboardRetry.calls.board += 1;
            throw new Error("Board unavailable");
          },
        };
      `,
      "/ui/useToast": "export const useToast = () => ({ toast() {} });",
    },
  });
  const { default: LeaderboardView } = await vite.ssrLoadModule("/components/LeaderboardView.tsx");
  root = createRoot(container);
  const props = {
    enableInsightsSync: async () => true,
    insightsSyncEnabled: false,
    onSignIn: () => {
      calls.signIn += 1;
    },
    syncAllowedByPolicy: true,
  };
  await act(async () => root.render(createElement(LeaderboardView, props)));
  let retry = findElement(
    container,
    (node) => node.tagName === "BUTTON" && node.textContent === en.insights.leaderboard.retry
  );
  assert.ok(retry, `Retry button missing: ${container.textContent}`);
  await act(async () => retry.dispatchEvent({ type: "click", bubbles: true, button: 0 }));

  assert.deepEqual(calls, { auth: 1, access: 0, board: 0, signIn: 0 });

  state.offline = false;
  await act(async () => root.render(createElement(LeaderboardView, props)));
  assert.deepEqual(calls, { auth: 1, access: 1, board: 1, signIn: 0 });
  retry = findElement(
    container,
    (node) => node.tagName === "BUTTON" && node.textContent === en.insights.leaderboard.retry
  );
  assert.ok(retry, `Board Retry button missing: ${container.textContent}`);
  await act(async () => retry.dispatchEvent({ type: "click", bubbles: true, button: 0 }));
  assert.deepEqual(calls, { auth: 1, access: 1, board: 2, signIn: 0 });

  state.offline = true;
  await act(async () => root.render(createElement(LeaderboardView, props)));
  retry = findElement(
    container,
    (node) => node.tagName === "BUTTON" && node.textContent === en.insights.leaderboard.retry
  );
  assert.ok(retry, `Offline board Retry button missing: ${container.textContent}`);
  await act(async () => retry.dispatchEvent({ type: "click", bubbles: true, button: 0 }));
  assert.deepEqual(calls, { auth: 2, access: 1, board: 2, signIn: 0 });
});
