const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals } = require("../lib/rendererTestHarness");

// Participation is one account preference shared by every surface, so these
// cover the transitions a single hook instance could never see: a leave taken
// in Settings while the leaderboard is mounted behind it, and the re-read that
// the sync-toggle flip fires before that leave has reached the account.

const pendingKey = (userId) => `leaderboardLeavePending:${encodeURIComponent(userId)}`;
// The record carries a delivery-attempt count, so presence is the signal.
const pendingUserIds = (storage) =>
  ["user_1", "user_2"].filter((userId) => storage.getItem(pendingKey(userId)) != null);
const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for the mocked request to start");
};

async function validateAuthContext(userId = "user_1", authGeneration = 7, reset = true) {
  const auth = require("../../src/lib/authRequestContext.ts");
  if (reset) auth.resetAuthRequestContextForTests();
  const token = `token-${userId}-${authGeneration}`;
  global.window.location ??= { origin: "https://desktop.openwhispr.test" };
  global.window.electronAPI.authGetTokenState = async () => ({ token, generation: authGeneration });
  await auth.handleAuthRequestSuccess({
    data: { user: { id: userId } },
    response: new Response("{}", { status: 200 }),
    request: {
      url: "https://auth.openwhispr.test/api/auth/get-session",
      headers: new Headers({ Authorization: `Bearer ${token}` }),
      openWhisprAuthGeneration: authGeneration,
    },
  });
  assert.equal(auth.commitValidatedAuthContext(authGeneration, userId), true);
  return { userId, authGeneration };
}

async function loadStore(t, { initialStorage = {}, cloudApiRequest }) {
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
    configured: false,
    ready: false,
    error: null,
    updating: false,
  });
  const context = await validateAuthContext();
  return { context, requests, storage, store: useLeaderboardParticipationStore };
}

const participation = (enabled) => ({
  success: true,
  data: { data: { configured: true, enabled, updatedAt: null } },
});

test("a leave the account refused stops showing the user as participating", async (t) => {
  const { context, storage, store } = await loadStore(t, {
    cloudApiRequest: async () => ({ success: false, status: 0, error: "offline" }),
  });

  assert.equal(await store.getState().leave(context), false);
  assert.equal(store.getState().enabled, false);
  assert.equal(store.getState().configured, true);
  assert.equal(store.getState().ready, true);
  assert.equal(store.getState().updating, false);
  assert.deepEqual(
    pendingUserIds(storage),
    ["user_1"],
    "the opt-out has to survive the network that refused it"
  );
  assert.equal(
    store.getState().leavePending,
    true,
    "the toggle reads off, so this is what stops the leave from passing as done"
  );
});

// An API without the participation route cannot be holding the account on a
// board, so there is no leave left to owe — and nothing to keep telling the
// user about.
test("a leave the API can no longer act on is not reported as still owed", async (t) => {
  const { context, storage, store } = await loadStore(t, {
    cloudApiRequest: async () => ({ success: false, status: 404, error: "gone" }),
  });

  assert.equal(await store.getState().leave(context), false);
  assert.equal(store.getState().enabled, false);
  assert.equal(store.getState().leavePending, false);
  assert.deepEqual(pendingUserIds(storage), []);
});

test("a refresh reports a leave the account is still waiting on", async (t) => {
  const { context, store } = await loadStore(t, {
    initialStorage: { [pendingKey("user_1")]: "true" },
    cloudApiRequest: async (request) =>
      request.method === "PATCH"
        ? { success: false, status: 500, error: "boom" }
        : { success: true, data: { data: { configured: true, enabled: true, updatedAt: null } } },
  });

  await store.getState().refresh(context);

  assert.equal(store.getState().enabled, false, "the row still says joined, but the user left");
  assert.equal(store.getState().leavePending, true);
});

test("a delivered leave, or a newer join, retires the owed-leave notice", async (t) => {
  let patchFails = true;
  // The account row: a PATCH that lands moves it, a GET reads it back.
  let serverEnabled = true;
  const { context, store } = await loadStore(t, {
    initialStorage: { [pendingKey("user_1")]: "true" },
    cloudApiRequest: async (request) => {
      if (request.method === "PATCH") {
        if (patchFails) return { success: false, status: 500, error: "boom" };
        serverEnabled = request.body.enabled;
      }
      return {
        success: true,
        data: { data: { configured: true, enabled: serverEnabled, updatedAt: null } },
      };
    },
  });

  await store.getState().refresh(context);
  assert.equal(store.getState().leavePending, true);

  patchFails = false;
  await store.getState().refresh(context);
  assert.equal(store.getState().leavePending, false, "the retry landed on this read");
  assert.equal(store.getState().enabled, false);

  assert.equal(await store.getState().join(context), true);
  assert.equal(store.getState().leavePending, false);
  assert.equal(store.getState().enabled, true);
});

// A refresh trigger can arrive while the leave PATCH is still in flight. The
// read must not report the row the leave is busy changing.
test("a read started during a leave never reports the account still joined", async (t) => {
  let releaseLeave;
  const { context, requests, store } = await loadStore(t, {
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

  const leaving = store.getState().leave(context);
  await waitFor(() => typeof releaseLeave === "function");
  await store.getState().refresh(context);
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
  const { context, store } = await loadStore(t, {
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

  const reading = store.getState().refresh(context);
  await waitFor(() => typeof releaseRead === "function");
  const leaving = store.getState().leave(context);

  releaseRead();
  await reading;
  await leaving;
  assert.equal(
    store.getState().enabled,
    false,
    "the completed leave is newer than the read it overtook"
  );
});

test("a join retires the queued leave before its own request goes out", async (t) => {
  const { context, requests, storage, store } = await loadStore(t, {
    initialStorage: { [pendingKey("user_1")]: "true", [pendingKey("user_2")]: "true" },
    cloudApiRequest: async () => participation(true),
  });

  assert.equal(await store.getState().join(context), true);
  assert.deepEqual(requests, [
    {
      method: "PATCH",
      path: "/api/analytics/participation",
      // The zone rides along with the join because that is what starts the
      // account's history reconciliation, and only this device knows which
      // calendar day its dictations belong to.
      body: {
        enabled: true,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      },
      public: false,
      expectedAuthGeneration: 7,
    },
  ]);
  assert.deepEqual(
    pendingUserIds(storage),
    ["user_2"],
    "only the joining account's leave is retired"
  );
  assert.equal(store.getState().enabled, true);
  assert.equal(store.getState().configured, true);
  assert.equal(store.getState().error, null);
});

test("a join sends UTC when the runtime exposes no timezone", async (t) => {
  const { context, requests, store } = await loadStore(t, {
    cloudApiRequest: async () => participation(true),
  });
  t.mock.method(Intl, "DateTimeFormat", () => ({
    resolvedOptions: () => ({ timeZone: "" }),
  }));

  assert.equal(await store.getState().join(context), true);
  assert.deepEqual(requests[0].body, { enabled: true, timeZone: "UTC" });
});

test("a failed join reports that participation did not change", async (t) => {
  const { context, storage, store } = await loadStore(t, {
    cloudApiRequest: async () => ({ success: false, status: 500, error: "server error" }),
  });

  assert.equal(await store.getState().join(context), false);
  assert.equal(store.getState().enabled, false);
  assert.equal(store.getState().configured, true);
  assert.equal(store.getState().error, "write");
  assert.equal(store.getState().updating, false);
  assert.deepEqual(
    pendingUserIds(storage),
    ["user_1"],
    "an ambiguous failure must compensate if the server committed before the response was lost"
  );
});

test("a newer join clears an older ambiguous join failure", async (t) => {
  let releaseFirstJoin;
  let requestCount = 0;
  const { context, requests, storage, store } = await loadStore(t, {
    cloudApiRequest: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        await new Promise((resolve) => {
          releaseFirstJoin = resolve;
        });
        return { success: false, status: 0, error: "response lost" };
      }
      return participation(true);
    },
  });

  const firstJoin = store.getState().join(context);
  await waitFor(() => typeof releaseFirstJoin === "function");
  const secondJoin = store.getState().join(context);
  await Promise.resolve();
  assert.equal(requests.length, 1, "same-account writes must not race at the API");

  releaseFirstJoin();
  assert.equal(await firstJoin, false);
  assert.equal(await secondJoin, true);
  assert.deepEqual(pendingUserIds(storage), [], "the latest explicit join wins");
  assert.equal(store.getState().enabled, true);
  assert.equal(store.getState().updating, false);
});

test("a newer join clears an older failed leave without being undone later", async (t) => {
  let releaseLeave;
  let requestCount = 0;
  const { context, requests, storage, store } = await loadStore(t, {
    cloudApiRequest: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        await new Promise((resolve) => {
          releaseLeave = resolve;
        });
        return { success: false, status: 0, error: "offline" };
      }
      return participation(true);
    },
  });

  const leave = store.getState().leave(context);
  await waitFor(() => typeof releaseLeave === "function");
  const join = store.getState().join(context);
  await Promise.resolve();
  assert.equal(requests.length, 1, "the newer join waits for the leave to settle");

  releaseLeave();
  assert.equal(await leave, false);
  assert.equal(await join, true);
  assert.deepEqual(pendingUserIds(storage), [], "the latest explicit join retires the leave");
  assert.equal(store.getState().enabled, true);
});

test("a refresh flushes the pending leave before reporting the answer", async (t) => {
  let accountEnabled = true;
  const { context, requests, storage, store } = await loadStore(t, {
    initialStorage: { [pendingKey("user_1")]: "true" },
    cloudApiRequest: async (request) => {
      if (request.method === "PATCH") accountEnabled = request.body.enabled;
      return participation(accountEnabled);
    },
  });

  await store.getState().refresh(context);
  assert.deepEqual(
    requests.map((request) => request.method),
    ["PATCH", "GET"],
    "the opt-out has to land before the read that reports it"
  );
  assert.deepEqual(pendingUserIds(storage), []);
  assert.equal(store.getState().enabled, false);
});

test("a participation read that fails offers a retry rather than a stale answer", async (t) => {
  const { context, store } = await loadStore(t, {
    cloudApiRequest: async () => ({ success: false, status: 0, error: "offline" }),
  });
  store.setState({ enabled: true, ready: true });

  await store.getState().refresh(context);
  assert.equal(store.getState().enabled, false);
  assert.equal(store.getState().error, "read");
  assert.equal(store.getState().ready, true);
});

test("simultaneous participation reads for one account share one request", async (t) => {
  let releaseRead;
  const { context, requests, store } = await loadStore(t, {
    cloudApiRequest: async () => {
      await new Promise((resolve) => {
        releaseRead = resolve;
      });
      return participation(true);
    },
  });

  const first = store.getState().refresh(context);
  const second = store.getState().refresh(context);
  await waitFor(() => typeof releaseRead === "function");
  assert.equal(requests.length, 1);

  releaseRead();
  await Promise.all([first, second]);
  assert.equal(store.getState().enabled, true);
});

test("signing out drops the previous account's answer", async (t) => {
  const { store } = await loadStore(t, { cloudApiRequest: async () => participation(true) });
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
  const { context, storage, store } = await loadStore(t, {
    cloudApiRequest: async () => {
      await new Promise((resolve) => {
        releaseLeave = resolve;
      });
      return { success: false, status: 0, error: "offline" };
    },
  });

  const leaving = store.getState().leave(context);
  await waitFor(() => typeof releaseLeave === "function");
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

test("a departing account's write cannot clear a newer account's write state", async (t) => {
  let releaseFirstWrite;
  let releaseSecondWrite;
  let requestCount = 0;
  const { context, store } = await loadStore(t, {
    cloudApiRequest: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        await new Promise((resolve) => {
          releaseFirstWrite = resolve;
        });
        return { success: false, status: 0, error: "offline" };
      }
      await new Promise((resolve) => {
        releaseSecondWrite = resolve;
      });
      return participation(true);
    },
  });

  const firstWrite = store.getState().leave(context);
  await waitFor(() => typeof releaseFirstWrite === "function");
  store.getState().reset();
  const user2 = await validateAuthContext("user_2", 8, false);
  const secondWrite = store.getState().join(user2);

  releaseFirstWrite();
  await firstWrite;
  assert.equal(
    store.getState().updating,
    true,
    "the first account must not make the second account's pending write look complete"
  );

  await waitFor(() => typeof releaseSecondWrite === "function");
  releaseSecondWrite();
  await secondWrite;
  assert.equal(store.getState().updating, false);
  assert.equal(store.getState().enabled, true);
});
