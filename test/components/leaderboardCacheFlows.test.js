const test = require("node:test");
const assert = require("node:assert/strict");
const { act, createElement } = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

const READY_SCOPE = {
  key: "workspace:team",
  kind: "workspace",
  id: "team",
  name: "Team",
  memberCount: 2,
  state: "ready",
  role: "member",
};
const READY_ACCESS = {
  state: "ready",
  domain: null,
  colleagueCount: 2,
  invitation: null,
  joinableWorkspace: null,
  scopes: [READY_SCOPE],
};
const BOARD = {
  scope: READY_SCOPE,
  viewerUserId: "user-a",
  metric: "total_words",
  range: "week",
  weekStart: "2026-11-09",
  availableWeekStarts: ["2026-11-09"],
  leaders: [],
  members: [],
  totalMembers: 2,
  viewerRank: null,
  page: 0,
  pageSize: 20,
  generatedAt: "2026-11-17T10:00:00.000Z",
  refreshAfterSeconds: 60,
};
const BOARD_KEY = JSON.stringify([READY_SCOPE.key, "total_words", "week", null, 0]);

// Mounts the real LeaderboardSection over mocked services. `state.getAccess` and
// `state.getLeaderboard` answer the reads; the dialogs are stand-ins that only
// show whether the section rendered them.
async function mountSection(
  t,
  { access, accessAgeMs = 0, board, boardAgeMs = 0, state, beforeRender, participating = true }
) {
  let root;
  t.after(() => act(() => root?.unmount()));
  installBrowserGlobals(t, { window: { clearInterval() {}, dispatchEvent() {} } });
  const container = installInteractiveDom(t);
  state.accessReads = 0;
  state.boardReads = 0;
  state.inviteMounts = 0;
  globalThis.__leaderboardCacheFlows = state;
  t.after(() => delete globalThis.__leaderboardCacheFlows);
  t.mock.method(console, "error", () => {});
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-leaderboard-cache-flows-",
    mockModules: {
      "/lib/authRequestContext": "export const getValidatedAuthGeneration = () => 7;",
      "/stores/workspaceStore": `
        import { clearCachedLeaderboards } from '/lib/insightsCache';
        const state = {
          loaded: true, workspaces: [], activeWorkspaceId: null,
          refresh: async () => {},
          refreshMembers: async () => {},
          setActiveWorkspaceId() {},
          // Mirrors the store: a created workspace drops the kept boards for everyone.
          createWorkspace: async (name) => {
            clearCachedLeaderboards();
            return { id: 'created', name };
          },
        };
        export const useWorkspaceStore = select => select(state);
        useWorkspaceStore.getState = () => state;
      `,
      "/services/LeaderboardService": `
        export const LeaderboardService = {
          getAccess: async () => {
            const state = globalThis.__leaderboardCacheFlows;
            state.accessReads += 1;
            return state.getAccess();
          },
          getLeaderboard: async () => {
            const state = globalThis.__leaderboardCacheFlows;
            state.boardReads += 1;
            return state.getLeaderboard();
          },
        };
      `,
      "/ui/useToast": "export const useToast = () => ({ toast() {} });",
      "/WorkspacesService": "export const WorkspacesService = { join: async () => {} };",
      "/SyncService": "export const syncService = { requestSyncAll() {} };",
      "/CreateWorkspaceDialog": `
        import { createElement } from 'react';
        import { useWorkspaceStore } from '/stores/workspaceStore';
        export default function CreateWorkspaceDialog({ open, onOpenChange, onCreated }) {
          if (!open) return null;
          const submit = async () => {
            const workspace = await useWorkspaceStore.getState().createWorkspace('Acme');
            onOpenChange(false);
            onCreated?.(workspace.id);
          };
          return createElement('button', { onClick: () => void submit() }, 'Submit workspace');
        }
      `,
      "/InviteTeammateDialog": `
        import { createElement, useEffect } from 'react';
        export default function InviteTeammateDialog() {
          useEffect(() => {
            globalThis.__leaderboardCacheFlows.inviteMounts += 1;
          }, []);
          return createElement('div', null, 'Invite dialog open');
        }
      `,
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
  cache.readCachedLeaderboardAccess("user-a").fetchedAt -= accessAgeMs;
  if (board) {
    cache.cacheLeaderboard("user-a", BOARD_KEY, board);
    cache.readCachedLeaderboard("user-a", BOARD_KEY).fetchedAt -= boardAgeMs;
  }
  beforeRender?.(cache, CloudApiError);
  const props = {
    accountId: "user-a",
    authGeneration: 7,
    authSettled: true,
    accountOffline: false,
    isSignedIn: true,
    participating,
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
  const click = (label) =>
    act(async () => {
      const button = findElement(
        container,
        (node) => node.tagName === "BUTTON" && node.textContent.includes(label)
      );
      assert.ok(button, `"${label}" is on screen`);
      button.dispatchEvent({ type: "click", bubbles: true });
    });
  return { cache, CloudApiError, container, click };
}

for (const rereadFails of [false, true]) {
  test(`accepting an invitation keeps the Joining card up until the new access ${rereadFails ? "fails" : "lands"}`, async (t) => {
    const reread = Promise.withResolvers();
    const state = { getAccess: () => reread.promise, getLeaderboard: async () => BOARD };
    const { container, click, CloudApiError } = await mountSection(t, {
      access: {
        state: "accept_invite",
        domain: null,
        colleagueCount: 2,
        invitation: { workspaceId: "team", workspaceName: "Team", inviterName: "Sam" },
        joinableWorkspace: null,
        scopes: [],
      },
      state,
    });
    assert.equal(state.accessReads, 0, "a fresh kept answer needs no read");

    await click("Join Team");
    assert.ok(container.textContent.includes("Joining…"), "the card stays while access re-reads");
    assert.equal(state.accessReads, 1, "only the card's own access read goes out");

    await act(async () =>
      rereadFails
        ? reread.reject(new CloudApiError("Unavailable", 503))
        : reread.resolve(READY_ACCESS)
    );
    assert.equal(state.accessReads, 1);
    assert.ok(!container.textContent.includes("Join Team"), "the accepted invitation is gone");
    if (rereadFails) {
      assert.ok(container.textContent.includes("We couldn't check your leaderboard access."));
    }
  });
}

for (const participating of [true, false]) {
  test(`creating a workspace opens its invite dialog once, ${participating ? "on the new board" : "before joining the leaderboard"}`, async (t) => {
    const reread = Promise.withResolvers();
    const state = { getAccess: () => reread.promise, getLeaderboard: async () => BOARD };
    const { container, click } = await mountSection(t, {
      access: {
        state: "create",
        domain: null,
        colleagueCount: 0,
        invitation: null,
        joinableWorkspace: null,
        scopes: [],
      },
      participating,
      state,
    });
    assert.ok(container.textContent.includes("Create your team leaderboard"));

    await click("Create workspace");
    await click("Submit workspace");
    assert.ok(
      container.textContent.includes("Invite dialog open"),
      "the invite dialog does not wait for access"
    );
    assert.equal(state.accessReads, 1, "the create's invalidation is the only access read");

    const created = { ...READY_SCOPE, key: "workspace:created", id: "created", state: "invite" };
    await act(async () => reread.resolve({ ...READY_ACCESS, scopes: [created] }));
    assert.equal(state.accessReads, 1);
    assert.ok(container.textContent.includes("Invite dialog open"), "the dialog stays open");
    assert.equal(state.inviteMounts, 1, "the new surface keeps the same dialog");
  });
}

test("reopening on a stale kept answer reads the board once", async (t) => {
  const accessReply = Promise.withResolvers();
  const boardReply = Promise.withResolvers();
  const state = { getAccess: () => accessReply.promise, getLeaderboard: () => boardReply.promise };
  await mountSection(t, {
    access: READY_ACCESS,
    accessAgeMs: 61_000,
    board: BOARD,
    boardAgeMs: 61_000,
    state,
  });
  assert.equal(state.accessReads, 1);
  assert.equal(state.boardReads, 1);

  // The cloud answers with an equal answer in a new object, as it always does.
  await act(async () => accessReply.resolve(structuredClone(READY_ACCESS)));
  assert.equal(state.boardReads, 1, "an unchanged access answer keeps the board read running");
  await act(async () => boardReply.resolve(BOARD));
  assert.equal(state.boardReads, 1);
});

for (const { status, clears } of [
  { status: 429, clears: false },
  { status: 400, clears: false },
  { status: 403, clears: true },
  { status: 404, clears: true },
]) {
  test(`a board ${status} ${clears ? "drops" : "keeps"} the other kept boards`, async (t) => {
    const otherPageKey = JSON.stringify([READY_SCOPE.key, "total_words", "week", null, 1]);
    const state = { getAccess: async () => READY_ACCESS };
    const { cache } = await mountSection(t, {
      access: READY_ACCESS,
      state,
      beforeRender(cache, CloudApiError) {
        cache.cacheLeaderboard("user-a", otherPageKey, { ...BOARD, page: 1 });
        state.getLeaderboard = async () => {
          throw new CloudApiError("Refused", status);
        };
      },
    });
    assert.equal(state.boardReads, 1);
    assert.equal(
      cache.readCachedLeaderboard("user-a", otherPageKey) !== undefined,
      !clears,
      clears ? "a moved gate drops every kept board" : "throttling or a bad request moves no gate"
    );
  });
}
