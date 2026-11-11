const test = require("node:test");
const assert = require("node:assert/strict");
const { act, createElement } = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");
const en = require("../../src/locales/en/translation.json");

test("a board participation refusal supersedes the mount's older joined answer", async (t) => {
  let root;
  t.after(() => act(() => root?.unmount()));
  installBrowserGlobals(t, {
    window: {
      clearInterval() {},
      electronAPI: { getOAuthProtocolRegistered: async () => true },
    },
  });
  const container = installInteractiveDom(t);
  const state = { reads: 0, boards: 0, releaseRead: null, readStarted: Promise.withResolvers() };
  globalThis.__leaderboardParticipationRecovery = state;
  t.after(() => delete globalThis.__leaderboardParticipationRecovery);
  t.mock.method(console, "error", () => {});
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-leaderboard-participation-recovery-",
    mockModules: {
      "/useAuth": `
        export const useAuth = () => ({
          isLoaded: true, isSignedIn: true, isOfflineAccount: false,
          user: { id: "user-a" }, refetch: async () => {},
        });
      `,
      "/hooks/useSettings": "export const useSettings = () => ({ dataRetentionEnabled: true });",
      "/lib/auth": "export const signInWithSSO = async () => ({});",
      "/lib/authRequestContext": `
        export const getValidatedAuthGeneration = () => 7;
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
        import { CloudApiError } from "/services/cloudApi";
        export const LeaderboardService = {
          flushPendingLeave: async () => false,
          getParticipation: async () => {
            const state = globalThis.__leaderboardParticipationRecovery;
            state.reads += 1;
            if (state.reads === 1) {
              state.readStarted.resolve();
              return new Promise((resolve) => {
                state.releaseRead = () => resolve({ enabled: true, configured: true });
              });
            }
            return { enabled: false, configured: true };
          },
          getAccess: async () => ({
            state: "ready", domain: "example.com", colleagueCount: 2,
            invitation: null, joinableWorkspace: null,
            scopes: [{
              key: "domain:example.com", kind: "domain", id: "example.com",
              name: "Example", memberCount: 2, state: "ready", role: null,
            }],
          }),
          getLeaderboard: async () => {
            globalThis.__leaderboardParticipationRecovery.boards += 1;
            await globalThis.__leaderboardParticipationRecovery.readStarted.promise;
            throw new CloudApiError("Left on another device", 403, "LEADERBOARD_PARTICIPATION_REQUIRED");
          },
        };
      `,
      "/ui/useToast": "export const useToast = () => ({ toast() {} });",
    },
  });
  const { default: LeaderboardView } = await vite.ssrLoadModule("/components/LeaderboardView.tsx");
  const { useLeaderboardParticipationStore: store } = await vite.ssrLoadModule(
    "/stores/leaderboardParticipationStore.ts"
  );
  store.setState({
    enabled: true,
    configured: true,
    ready: true,
    answeredUserId: "user-a",
    answeredAt: Date.now() - 5 * 60 * 1000 - 1,
  });
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(LeaderboardView, {
        enableInsightsSync: async () => true,
        insightsSyncEnabled: true,
        onSignIn() {},
        syncAllowedByPolicy: true,
      })
    )
  );
  assert.equal(state.boards, 1, "the board detects the participation change during the mount read");
  await act(async () => state.releaseRead());

  assert.ok(
    findElement(
      container,
      (node) => node.tagName === "BUTTON" && node.textContent === en.insights.leaderboard.joinCta
    ),
    `the current participation answer should show Join: ${container.textContent}`
  );
  assert.equal(state.reads, 2);
  assert.equal(store.getState().enabled, false);
});
