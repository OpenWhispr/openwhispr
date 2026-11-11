const test = require("node:test");
const assert = require("node:assert/strict");
const { act, createElement } = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

const cases = [
  { name: "a roster change", invalidate: "clearCachedLeaderboards" },
  { name: "an account-cache purge", invalidate: "clearInsightsCache" },
  { name: "leaving Insights", unmount: true },
  {
    name: "a workspace leave after leaving Insights",
    unmount: true,
    invalidate: "clearCachedLeaderboards",
  },
  {
    name: "a roster change followed by a fresh answer",
    invalidate: "clearCachedLeaderboards",
    reject: true,
  },
];

for (const scenario of cases) {
  test(`late leaderboard replies cannot undo ${scenario.name}`, async (t) => {
    let root;
    t.after(() => act(() => root?.unmount()));
    installBrowserGlobals(t, { window: { clearInterval() {} } });
    const container = installInteractiveDom(t);
    const scope = {
      key: "workspace:removed",
      kind: "workspace",
      id: "removed",
      name: "Removed workspace",
      memberCount: 2,
      state: "ready",
      role: "member",
    };
    const access = {
      state: "ready",
      domain: null,
      colleagueCount: 2,
      invitation: null,
      joinableWorkspace: null,
      scopes: [scope],
    };
    const currentAccess = { ...access, state: "create", scopes: [] };
    const member = {
      userId: "coworker",
      name: "Former coworker",
      email: "coworker@example.com",
      image: null,
      totalWords: 20,
      desktopWords: 20,
      mobileWords: 0,
      averageWpm: null,
      currentStreakDays: 0,
      rank: 1,
    };
    const board = {
      scope,
      viewerUserId: "user-a",
      metric: "total_words",
      range: "week",
      weekStart: "2026-11-09",
      availableWeekStarts: ["2026-11-09"],
      leaders: [member],
      members: [member],
      totalMembers: 2,
      viewerRank: null,
      page: 0,
      pageSize: 20,
      generatedAt: new Date().toISOString(),
      refreshAfterSeconds: 60,
    };
    const currentBoard = { ...board, leaders: [], members: [], totalMembers: 0 };
    const state = {
      accessReads: 0,
      boardReads: 0,
      access: Promise.withResolvers(),
      board: Promise.withResolvers(),
      currentAccess,
      currentBoard,
    };
    globalThis.__leaderboardCacheInvalidation = state;
    t.after(() => delete globalThis.__leaderboardCacheInvalidation);
    t.mock.method(console, "error", () => {});
    const vite = await createRendererServer(t, {
      cachePrefix: "openwhispr-leaderboard-cache-invalidation-",
      mockModules: {
        "/lib/authRequestContext": "export const getValidatedAuthGeneration = () => 7;",
        "/stores/workspaceStore": `
          const state = { loaded: true, workspaces: [], activeWorkspaceId: null };
          export const useWorkspaceStore = select => select(state);
        `,
        "/services/LeaderboardService": `
          export const LeaderboardService = {
            getAccess: async () => {
              const state = globalThis.__leaderboardCacheInvalidation;
              return ++state.accessReads === 1 ? state.access.promise : state.currentAccess;
            },
            getLeaderboard: async () => {
              const state = globalThis.__leaderboardCacheInvalidation;
              return ++state.boardReads === 1 ? state.board.promise : state.currentBoard;
            },
          };
        `,
        "/ui/useToast": "export const useToast = () => ({ toast() {} });",
        "/ui/select": `
          import { createElement } from 'react';
          const Wrapper = ({children}) => createElement('div', null, children);
          export const Select = Wrapper, SelectTrigger = Wrapper, SelectValue = Wrapper,
            SelectContent = Wrapper, SelectItem = Wrapper;
        `,
      },
    });
    const { default: Section } = await vite.ssrLoadModule("/components/LeaderboardSection.tsx");
    const cache = await vite.ssrLoadModule("/lib/insightsCache.ts");
    const { CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts");
    cache.cacheLeaderboardAccess("user-a", access);
    const keptAccess = cache.readCachedLeaderboardAccess("user-a");
    keptAccess.fetchedAt -= 61_000;
    const props = {
      accountId: "user-a",
      authGeneration: 7,
      authSettled: true,
      accountOffline: false,
      isSignedIn: true,
      participating: true,
      cloudAccessAllowed: true,
      canJoin: true,
      participationReady: true,
      participationError: null,
      participationUpdating: false,
      participationLeavePending: false,
      onJoin: async () => true,
      onLeave: async () => true,
      onRefreshParticipation() {},
      onSessionRefresh() {},
      onSignIn() {},
      onSsoSignIn() {},
      ssoActionDisabled: false,
      ssoRecoveryError: null,
      ssoStarting: false,
    };
    root = createRoot(container);
    await act(async () => root.render(createElement(Section, props)));
    assert.equal(state.accessReads, 1);
    assert.equal(state.boardReads, 1);

    if (scenario.unmount) {
      await act(() => root.unmount());
      root = null;
    }
    if (scenario.invalidate) cache[scenario.invalidate]();
    const requestKey = JSON.stringify([scope.key, "total_words", "week", null, 0]);
    if (scenario.reject) {
      cache.cacheLeaderboardAccess("user-a", currentAccess);
      cache.cacheLeaderboard("user-a", requestKey, currentBoard);
    }
    await act(async () => {
      if (scenario.reject) {
        state.access.reject(new CloudApiError("Old access failed", 503));
        state.board.reject(new CloudApiError("Old board refused", 403));
      } else {
        state.access.resolve(access);
        state.board.resolve(board);
      }
    });

    const nextAccess = cache.readCachedLeaderboardAccess("user-a");
    const nextBoard = cache.readCachedLeaderboard("user-a", requestKey);
    if (scenario.reject) {
      assert.equal(nextAccess?.value, currentAccess, "an old error cannot clear newer access");
      assert.equal(nextBoard?.value, currentBoard, "an old refusal cannot clear a newer board");
    } else {
      assert.equal(
        nextAccess,
        scenario.invalidate ? null : keptAccess,
        "retired access must not refresh the cache"
      );
      assert.equal(nextBoard, undefined, "retired rows must not repopulate the cache");
    }
    assert.equal(cache.cachedLeaderboardWeekStarts("user-a").size, 0);
    if (root) await act(() => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(createElement(Section, props)));
    if (!scenario.reject) assert.equal(state.accessReads, 2, "reopening checks current access");
    assert.ok(!container.textContent.includes(member.name), "the former coworker never reappears");
  });
}
