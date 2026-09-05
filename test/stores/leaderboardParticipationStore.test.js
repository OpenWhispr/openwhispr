const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

// Participation is one account preference shared by every surface, so these
// cover the transitions a single hook instance could never see: a leave taken
// in Settings while the leaderboard is mounted behind it, and the re-read that
// the sync-toggle flip fires before that leave has reached the account.

const PENDING_KEY = "leaderboardLeavePendingUserIds";
const pendingUserIds = (storage) => JSON.parse(storage.getItem(PENDING_KEY) ?? "[]");

function loadStore(t, { initialStorage = {}, cloudApiRequest }) {
  const requests = [];
  const { storage } = installBrowserGlobals(t, {
    initialStorage,
    window: {
      electronAPI: {
        cloudApiRequest: async (request) => {
          requests.push(request);
          return cloudApiRequest(request);
        },
      },
    },
  });
  const {
    useLeaderboardParticipationStore,
  } = require("../../src/stores/leaderboardParticipationStore.ts");
  // The module is cached across cases in this file, so each starts from unknown.
  useLeaderboardParticipationStore.setState({
    enabled: false,
    ready: false,
    error: null,
    updating: false,
  });
  return { requests, storage, store: useLeaderboardParticipationStore };
}

const participation = (enabled) => ({
  success: true,
  data: { data: { configured: true, enabled, updatedAt: null } },
});

test("a leave the account refused stops showing the user as participating", async (t) => {
  const { storage, store } = loadStore(t, {
    cloudApiRequest: async () => ({ success: false, status: 0, error: "offline" }),
  });

  assert.equal(await store.getState().leave("user_1"), false);
  assert.equal(store.getState().enabled, false);
  assert.equal(store.getState().ready, true);
  assert.equal(store.getState().updating, false);
  assert.deepEqual(
    pendingUserIds(storage),
    ["user_1"],
    "the opt-out has to survive the network that refused it"
  );
});

// The Settings opt-out flips insightsSyncEnabled, which fires the leaderboard's
// re-read while the leave PATCH is still in flight. Before participation was
// shared, that read reported the row the leave was busy changing.
test("a read started during a leave never reports the account still joined", async (t) => {
  let releaseLeave;
  const { requests, store } = loadStore(t, {
    cloudApiRequest: async (request) => {
      if (request.method === "PATCH") {
        await new Promise((resolve) => {
          releaseLeave = resolve;
        });
        return { success: false, status: 500, error: "server error" };
      }
      return participation(true);
    },
  });

  const leaving = store.getState().leave("user_1");
  await store.getState().refresh("user_1");
  assert.deepEqual(
    requests.map((request) => request.method),
    ["PATCH"],
    "the read must defer to the write already changing the row"
  );

  releaseLeave();
  assert.equal(await leaving, false);
  assert.equal(store.getState().enabled, false);
  assert.equal(store.getState().ready, true);
});

test("a read that resolves after a write is retired by it", async (t) => {
  let releaseRead;
  const { store } = loadStore(t, {
    cloudApiRequest: async (request) => {
      if (request.method === "GET") {
        await new Promise((resolve) => {
          releaseRead = resolve;
        });
        return participation(true);
      }
      return participation(false);
    },
  });

  const reading = store.getState().refresh("user_1");
  await store.getState().leave("user_1");
  assert.equal(store.getState().enabled, false);

  releaseRead();
  await reading;
  assert.equal(
    store.getState().enabled,
    false,
    "the completed leave is newer than the read it overtook"
  );
});

test("a join retires the queued leave before its own request goes out", async (t) => {
  const { requests, storage, store } = loadStore(t, {
    initialStorage: { [PENDING_KEY]: '["user_1","user_2"]' },
    cloudApiRequest: async () => participation(true),
  });

  await store.getState().join("user_1");
  assert.deepEqual(requests, [
    {
      method: "PATCH",
      path: "/api/analytics/participation",
      body: { enabled: true },
      public: undefined,
      expectedAuthGeneration: undefined,
    },
  ]);
  assert.deepEqual(
    pendingUserIds(storage),
    ["user_2"],
    "only the joining account's leave is retired"
  );
  assert.equal(store.getState().enabled, true);
  assert.equal(store.getState().error, null);
});

test("a refresh flushes the pending leave before reporting the answer", async (t) => {
  let accountEnabled = true;
  const { requests, storage, store } = loadStore(t, {
    initialStorage: { [PENDING_KEY]: '["user_1"]' },
    cloudApiRequest: async (request) => {
      if (request.method === "PATCH") accountEnabled = request.body.enabled;
      return participation(accountEnabled);
    },
  });

  await store.getState().refresh("user_1");
  assert.deepEqual(
    requests.map((request) => request.method),
    ["PATCH", "GET"],
    "the opt-out has to land before the read that reports it"
  );
  assert.deepEqual(pendingUserIds(storage), []);
  assert.equal(store.getState().enabled, false);
});

test("a participation read that fails offers a retry rather than a stale answer", async (t) => {
  const { store } = loadStore(t, {
    cloudApiRequest: async () => ({ success: false, status: 0, error: "offline" }),
  });
  store.setState({ enabled: true, ready: true });

  await store.getState().refresh("user_1");
  assert.equal(store.getState().enabled, false);
  assert.equal(store.getState().error, "read");
  assert.equal(store.getState().ready, true);
});

test("signing out drops the previous account's answer", async (t) => {
  const { store } = loadStore(t, { cloudApiRequest: async () => participation(true) });
  store.setState({ enabled: true, ready: true, error: "read" });

  store.getState().reset();
  assert.equal(store.getState().enabled, false);
  assert.equal(store.getState().ready, false);
  assert.equal(store.getState().error, null);
});

// An account switch resets the store while a write is still out. Its answer is
// about the account that left, so it must not settle the one that replaced it,
// and the read it defers must not stay deferred for as long as it takes to fail.
test("a write left over from the departing account cannot settle the next one", async (t) => {
  let releaseLeave;
  const { storage, store } = loadStore(t, {
    cloudApiRequest: async () => {
      await new Promise((resolve) => {
        releaseLeave = resolve;
      });
      return { success: false, status: 0, error: "offline" };
    },
  });

  const leaving = store.getState().leave("user_1");
  store.getState().reset();
  assert.equal(
    store.getState().updating,
    false,
    "the departed account's write must stop deferring the next account's read"
  );

  releaseLeave();
  assert.equal(await leaving, false);
  assert.equal(store.getState().enabled, false);
  assert.equal(store.getState().ready, false, "the stale write must not report an answer");
  assert.deepEqual(
    pendingUserIds(storage),
    ["user_1"],
    "the opt-out is tagged with the account that asked, so the reset cannot drop it"
  );
});
