const test = require("node:test");
const assert = require("node:assert/strict");

const values = new Map();
const storage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};
global.localStorage = storage;
global.window = {
  localStorage: storage,
  addEventListener: () => {},
  removeEventListener: () => {},
};

const {
  getUsageState,
  isPastDueUsage,
  loadUsage,
  normalizeUsage,
  retryUsage,
  setUsageAccount,
  watchForUpgrade,
} = require("../../src/lib/usageStore.ts");

const BUSINESS = { plan: "business", status: "active", isSubscribed: true, limit: -1 };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function reset() {
  setUsageAccount(null);
  values.clear();
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("an old response shape still resolves a personal entitlement", () => {
  const legacy = normalizeUsage({ plan: "business", status: "active", isSubscribed: true });
  assert.deepEqual(legacy.entitlementSources, { personal: true, workspaceIds: [] });
  assert.equal(legacy.isSubscribed, true);

  const trial = normalizeUsage({ plan: "free", status: "active", isTrial: true });
  assert.equal(trial.entitlementSources.personal, true);

  const free = normalizeUsage({ plan: "free", status: "active" });
  assert.equal(free.entitlementSources.personal, false);
});

test("a missing limit is unknown, not the free-tier allowance", () => {
  // 2000 here would put a business account whose limit the API omitted onto a
  // free-tier meter; 0 fails the `limit > 0` guard every meter is behind.
  assert.equal(normalizeUsage({ plan: "business", isSubscribed: true }).limit, 0);
  assert.equal(normalizeUsage({ plan: "free", limit: 2000 }).limit, 2000);
  assert.equal(normalizeUsage({ plan: "business", limit: -1 }).limit, -1);
});

test("an explicit entitlementSources block wins over the inferred one", () => {
  const migrated = normalizeUsage({
    plan: "free",
    status: "active",
    isSubscribed: true,
    entitlementSources: { personal: false, workspaceIds: ["ws-1"] },
  });
  assert.deepEqual(migrated.entitlementSources, { personal: false, workspaceIds: ["ws-1"] });
});

test("past due is only derived from a paid plan", () => {
  assert.equal(isPastDueUsage(normalizeUsage({ plan: "business", status: "past_due" })), true);
  assert.equal(isPastDueUsage(normalizeUsage({ plan: "free", status: "past_due" })), false);
});

test("a successful load publishes the account's entitlement and the persisted flag", async (t) => {
  t.after(reset);
  reset();

  setUsageAccount("user-a");
  await loadUsage(async () => BUSINESS);

  const state = getUsageState();
  assert.equal(state.status, "success");
  assert.equal(state.accountId, "user-a");
  assert.equal(state.data.isSubscribed, true);
  assert.equal(localStorage.getItem("isSubscribed"), "true");
});

test("switching accounts drops the previous account's in-flight response and flag", async (t) => {
  t.after(reset);
  reset();

  localStorage.setItem("isSubscribed", "true");
  setUsageAccount("user-a");
  const gate = deferred();
  const inFlight = loadUsage(() => gate.promise);

  setUsageAccount("user-b");
  gate.resolve(BUSINESS);
  await inFlight;

  const state = getUsageState();
  assert.equal(state.accountId, "user-b");
  assert.equal(state.status, "idle");
  assert.equal(localStorage.getItem("isSubscribed"), null);
});

test("relaunching the same account keeps the persisted flag", (t) => {
  t.after(reset);
  reset();

  // A restart starts from a null in-memory account with both markers persisted;
  // clearing here would strand an offline session with sync disabled.
  localStorage.setItem("openwhispr:usageAccountId", "user-a");
  localStorage.setItem("isSubscribed", "true");

  setUsageAccount("user-a");

  assert.equal(localStorage.getItem("isSubscribed"), "true");
});

test("a flag with no recorded owner is not inherited", (t) => {
  t.after(reset);
  reset();

  // The first launch of a build that records the owner: the flag on disk was
  // written by whoever was signed in before, and cannot be attributed.
  localStorage.setItem("isSubscribed", "true");

  setUsageAccount("user-b");

  assert.equal(localStorage.getItem("isSubscribed"), null);
});

test("signing out clears the persisted flag", async (t) => {
  t.after(reset);
  reset();

  setUsageAccount("user-a");
  await loadUsage(async () => BUSINESS);
  setUsageAccount(null);

  assert.equal(localStorage.getItem("isSubscribed"), null);
  assert.deepEqual(getUsageState(), { status: "idle", accountId: null });
});

test("a failed load reports an error instead of a free plan", async (t) => {
  t.after(reset);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();

  setUsageAccount("user-a");
  await loadUsage(async () => {
    throw new Error("Network unreachable");
  });

  const state = getUsageState();
  assert.equal(state.status, "error");
  assert.equal(state.error, "Network unreachable");
  assert.equal(state.isRetrying, true);
  assert.equal(localStorage.getItem("isSubscribed"), null);
});

test("transient failures retry with bounded backoff, then stop", async (t) => {
  t.after(reset);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();

  let attempts = 0;
  const failing = async () => {
    attempts += 1;
    throw new Error("boom");
  };

  setUsageAccount("user-a");
  await loadUsage(failing);
  assert.equal(attempts, 1);

  for (const delay of [2000, 4000, 8000]) {
    t.mock.timers.tick(delay);
    await flush();
  }

  assert.equal(attempts, 4);
  assert.equal(getUsageState().isRetrying, false, "backoff budget is exhausted");
});

test("an expired session is not retried", async (t) => {
  t.after(reset);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();

  setUsageAccount("user-a");
  await loadUsage(async () => {
    const error = new Error("Session expired");
    error.code = "AUTH_EXPIRED";
    throw error;
  });

  const state = getUsageState();
  assert.equal(state.code, "AUTH_EXPIRED");
  assert.equal(state.isRetrying, false);
});

test("a manual retry restores the backoff budget and refetches", async (t) => {
  t.after(reset);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();

  let attempts = 0;
  setUsageAccount("user-a");
  await loadUsage(async () => {
    attempts += 1;
    const error = new Error("Session expired");
    error.code = "AUTH_EXPIRED";
    throw error;
  });
  assert.equal(getUsageState().isRetrying, false);

  await retryUsage(async () => BUSINESS);
  assert.equal(attempts, 1);
  assert.equal(getUsageState().status, "success");
});

test("consumers share one request and one cached result", async (t) => {
  t.after(reset);
  reset();

  let calls = 0;
  const gate = deferred();
  const fetcher = () => {
    calls += 1;
    return gate.promise;
  };

  setUsageAccount("user-a");
  const first = loadUsage(fetcher);
  const second = loadUsage(fetcher);
  gate.resolve(BUSINESS);
  await Promise.all([first, second]);
  assert.equal(calls, 1, "concurrent mounts share the in-flight request");

  await loadUsage(fetcher);
  assert.equal(calls, 1, "a later mount reuses the cached success");

  await loadUsage(async () => ({ ...BUSINESS, isSubscribed: false }), { force: true });
  assert.equal(getUsageState().data.isSubscribed, false, "force bypasses the cache");
});

test("a forced load during an in-flight request refetches instead of adopting it", async (t) => {
  t.after(reset);
  reset();

  let calls = 0;
  const gate = deferred();
  const fetcher = () => {
    calls += 1;
    // Only the first call waits on the gate; the follow-up resolves immediately
    // with the words the forced caller knew about.
    return calls === 1 ? gate.promise : Promise.resolve({ ...BUSINESS, wordsUsed: 500 });
  };

  setUsageAccount("user-a");
  const initial = loadUsage(fetcher);
  const forced = loadUsage(fetcher, { force: true });
  const alsoForced = loadUsage(fetcher, { force: true });
  gate.resolve({ ...BUSINESS, wordsUsed: 100 });
  await Promise.all([initial, forced, alsoForced]);

  assert.equal(calls, 2, "concurrent forced callers coalesce into one follow-up");
  assert.equal(getUsageState().data.wordsUsed, 500);
});

test("a forced load queued across a sign-out does not fetch for the next account", async (t) => {
  t.after(reset);
  reset();

  let calls = 0;
  const gate = deferred();
  const fetcher = () => {
    calls += 1;
    return gate.promise;
  };

  setUsageAccount("user-a");
  const initial = loadUsage(fetcher);
  const forced = loadUsage(fetcher, { force: true });
  setUsageAccount(null);
  gate.resolve(BUSINESS);
  await Promise.all([initial, forced]);

  assert.equal(calls, 1);
  assert.equal(getUsageState().status, "idle");
});

test("a stale queued force does not clobber the next account's queued one", async (t) => {
  t.after(reset);
  reset();

  let calls = 0;
  const gateA = deferred();
  const gateB = deferred();
  const fetcher = () => {
    calls += 1;
    if (calls === 1) return gateA.promise;
    if (calls === 2) return gateB.promise;
    return Promise.resolve(BUSINESS);
  };

  setUsageAccount("user-a");
  const staleInitial = loadUsage(fetcher);
  const staleForced = loadUsage(fetcher, { force: true });

  setUsageAccount("user-b");
  const initial = loadUsage(fetcher);
  const forced = loadUsage(fetcher, { force: true });

  // user-a's request lands only after user-b has queued a force of its own.
  gateA.resolve(BUSINESS);
  await Promise.all([staleInitial, staleForced]);

  const alsoForced = loadUsage(fetcher, { force: true });
  gateB.resolve(BUSINESS);
  await Promise.all([initial, forced, alsoForced]);

  assert.equal(calls, 3, "the later forced caller joins user-b's surviving follow-up");
  assert.equal(getUsageState().accountId, "user-b");
});

test("the post-checkout poll keeps refetching until the webhook lands", async (t) => {
  t.after(reset);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();

  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return calls < 3 ? { ...BUSINESS, isSubscribed: false } : BUSINESS;
  };

  setUsageAccount("user-a");
  const watching = watchForUpgrade(fetcher);
  for (const delay of [2000, 4000]) {
    await flush();
    t.mock.timers.tick(delay);
  }
  await watching;

  assert.equal(calls, 3);
  assert.equal(getUsageState().data.isSubscribed, true);
});

test("a second upgrade watch is a no-op while one is running", async (t) => {
  t.after(reset);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();

  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return { ...BUSINESS, isSubscribed: false };
  };

  setUsageAccount("user-a");
  const watching = watchForUpgrade(fetcher);
  await watchForUpgrade(fetcher);
  assert.equal(calls, 1, "a second consumer does not start its own poll");

  for (const delay of [2000, 4000, 8000, 1]) {
    await flush();
    t.mock.timers.tick(delay);
  }
  await watching;

  assert.equal(calls, 4, "a webhook that never lands gives up after a bounded number of attempts");
});

test("an upgrade watch stops when the account changes", async (t) => {
  t.after(reset);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();

  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return { ...BUSINESS, isSubscribed: false };
  };

  setUsageAccount("user-a");
  const watching = watchForUpgrade(fetcher);
  await flush();

  setUsageAccount("user-b");
  t.mock.timers.tick(2000);
  await watching;

  assert.equal(calls, 1, "the poll does not carry into the next account");
  assert.equal(getUsageState().accountId, "user-b");
});

test("an error is never cached: the next consumer retries", async (t) => {
  t.after(reset);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  reset();

  setUsageAccount("user-a");
  await loadUsage(async () => {
    throw new Error("boom");
  });

  await loadUsage(async () => BUSINESS);
  assert.equal(getUsageState().status, "success");
});
