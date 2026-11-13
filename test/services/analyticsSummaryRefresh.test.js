const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const summary = (totalWords) => ({
  totalWords,
  totalDictations: 1,
  totalSpokenDurationMs: 1000,
  averageWpm: null,
  currentStreakDays: 1,
  longestStreakDays: 1,
  wpmCoveragePercent: 0,
  daily: [],
});

async function setup(t, kind = "upload") {
  const state = {
    pending: false,
    failWrite: false,
    failRead: false,
    words: 100,
    copy: null,
    modes: [],
    pendingRead: null,
  };
  t.mock.method(console, "error", () => {});
  const event = { event_id: "event", counter_version: 1 };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPendingAnalyticsEvents: async () => (state.pending && kind === "upload" ? [event] : []),
        getPendingAnalyticsDeletes: async () => (state.pending && kind === "delete" ? [event] : []),
        getPendingAnalyticsClear: async () =>
          state.pending && kind === "clear" ? { cleared_through: "2026-11-12T00:00:00Z" } : null,
        markAnalyticsEventsSynced: async () => {
          state.pending = false;
          return { updated: 1 };
        },
        hardDeleteAnalyticsEvents: async () => {
          state.pending = false;
        },
        completeAnalyticsClear: async () => {
          state.pending = false;
        },
        cloudApiRequest: async ({ method, path }) => {
          if (method !== "GET") {
            if (state.failWrite) return { success: false, status: 503, error: "offline" };
            state.words = kind === "upload" ? 101 : 0;
            return { success: true, data: { accepted: [event.event_id] } };
          }
          const mode = new URL(path, "https://api.test").searchParams.get("cache");
          state.modes.push(mode);
          if (state.failRead) return { success: false, status: 503, error: "offline" };
          if (mode !== "allow" || !state.copy) state.copy = summary(state.words);
          const result = { success: true, data: state.copy };
          return state.pendingRead ? state.pendingRead.promise.then(() => result) : result;
        },
      },
    },
  });
  const vite = await createRendererServer(t);
  const service = await vite.ssrLoadModule("/services/AnalyticsService.ts");
  return { state, ...service };
}

for (const kind of ["upload", "delete", "clear"]) {
  test(`a background check reads fresh after recovering an analytics ${kind}`, async (t) => {
    const { state, getAccountAnalyticsSummary, syncPendingAnalytics } = await setup(t, kind);
    await getAccountAnalyticsSummary("a");
    state.pending = true;
    state.failWrite = true;
    const sync = () => syncPendingAnalytics({ context: { accountId: "a", authGeneration: 7 } });
    await sync().catch(() => {});
    assert.equal(state.pending, true);
    await getAccountAnalyticsSummary("a", "allow");
    state.failWrite = false;
    await sync();
    assert.equal(state.pending, false);
    const fresh = await getAccountAnalyticsSummary("a", "allow");
    assert.equal(fresh.totalWords, kind === "upload" ? 101 : 0);
    await getAccountAnalyticsSummary("a", "allow");
    assert.deepEqual(state.modes, ["refresh", "refresh", "refresh", "allow"]);
  });
}

test("a failed fresh summary read keeps the next check fresh", async (t) => {
  const { state, getAccountAnalyticsSummary, syncPendingAnalytics } = await setup(t);
  await getAccountAnalyticsSummary("a");
  state.pending = true;
  await syncPendingAnalytics({ context: { accountId: "a", authGeneration: 7 } });
  state.failRead = true;
  await assert.rejects(getAccountAnalyticsSummary("a", "allow"));
  state.failRead = false;
  assert.equal((await getAccountAnalyticsSummary("a", "allow")).totalWords, 101);
  assert.deepEqual(state.modes, ["refresh", "refresh", "refresh"]);
});

test("a summary reply cannot acknowledge a later write or dirty another account", async (t) => {
  const { state, getAccountAnalyticsSummary, syncPendingAnalytics } = await setup(t);
  await getAccountAnalyticsSummary("a");
  const sync = () => syncPendingAnalytics({ context: { accountId: "a", authGeneration: 7 } });
  state.pending = true;
  await sync();
  state.pendingRead = Promise.withResolvers();
  const first = getAccountAnalyticsSummary("a", "allow");
  await new Promise((resolve) => setImmediate(resolve));
  state.pending = true;
  await sync();
  const pending = state.pendingRead;
  state.pendingRead = null;
  pending.resolve();
  await first;
  await getAccountAnalyticsSummary("b", "allow");
  await getAccountAnalyticsSummary("a", "allow");
  await getAccountAnalyticsSummary("a", "allow");
  assert.deepEqual(state.modes, ["refresh", "refresh", "allow", "refresh", "allow"]);
});
