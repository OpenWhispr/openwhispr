const test = require("node:test");
const assert = require("node:assert/strict");
const { act, createElement, useSyncExternalStore } = require("react");
const { createRoot } = require("react-dom/client");
const { useUsageReturnCountdown } = require("../../src/hooks/useUsageReturnCountdown.ts");
const { installBrowserGlobals, installHookDom } = require("../lib/rendererTestHarness");
const {
  getUsageState,
  loadUsage,
  setUsageAccount,
  subscribeUsage,
} = require("../../src/lib/usageStore.ts");

async function mountCountdown(t, availableAt, onRefresh, useTimestamp = (timestamp) => timestamp) {
  let root;
  t.after(async () => {
    await act(async () => root?.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const listeners = new Map();
  for (const target of [globalThis.window, globalThis.document]) {
    target.addEventListener = (name, listener) => listeners.set(name, listener);
    target.removeEventListener = (name) => listeners.delete(name);
  }
  let current;
  function Harness({ timestamp }) {
    current = useUsageReturnCountdown(useTimestamp(timestamp), onRefresh);
    return null;
  }
  root = createRoot(container);
  const render = async (timestamp) => {
    await act(async () => root.render(createElement(Harness, { timestamp })));
  };
  await render(availableAt);
  return {
    get current() {
      return current;
    },
    listeners,
    render,
    unmount: async () => {
      await act(async () => root.unmount());
      root = null;
    },
  };
}

test("deadline refreshes without fabricating a reset and accepts the next return", async (t) => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  let refreshes = 0;
  const mounted = await mountCountdown(t, new Date(now + 90_000).toISOString(), async () => {
    refreshes += 1;
  });
  assert.deepEqual(mounted.current, { unit: "minute", count: 2 });
  await act(async () => t.mock.timers.tick(60_000));
  assert.deepEqual(mounted.current, { unit: "minute", count: 1 });
  await act(async () => t.mock.timers.tick(30_000));
  assert.equal(mounted.current, null);
  assert.equal(refreshes, 1);
  await act(async () => {
    mounted.listeners.get("focus")();
    mounted.listeners.get("visibilitychange")();
  });
  assert.equal(refreshes, 1);
  await mounted.render(new Date(now + 120_000).toISOString());
  assert.deepEqual(mounted.current, { unit: "minute", count: 1 });
  await act(async () => t.mock.timers.tick(30_000));
  assert.equal(refreshes, 2);
});

test("a successful unchanged deadline rechecks after the server clock catches up", async (t) => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  const deadline = now + 1_000;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  t.after(async () => act(async () => setUsageAccount(null)));
  let fetches = 0;
  const fetcher = async () => {
    fetches += 1;
    const expired = Date.now() - 5_000 >= deadline;
    return {
      wordsUsed: expired ? 0 : 2_000,
      limit: 2_000,
      nextWordsAvailableAt: expired ? null : new Date(deadline).toISOString(),
    };
  };
  const mounted = await mountCountdown(
    t,
    null,
    () => loadUsage(fetcher, { force: true }),
    function useStoredTimestamp() {
      const state = useSyncExternalStore(subscribeUsage, getUsageState);
      return state.status === "success" ? state.data.nextWordsAvailableAt : null;
    }
  );
  await act(async () => {
    setUsageAccount("clock-skew-user");
    await loadUsage(fetcher);
  });
  await act(async () => t.mock.timers.tick(1_000));
  assert.equal(fetches, 2);
  assert.equal(getUsageState().data.wordsUsed, 2_000);
  assert.equal(mounted.current, null);
  await act(async () => t.mock.timers.tick(5_000));
  assert.equal(fetches, 3);
  assert.equal(getUsageState().data.wordsUsed, 0);
  await act(async () => t.mock.timers.tick(300_000));
  assert.equal(fetches, 3);
});

test("unchanged deadlines have bounded automatic retries and throttled focus recovery", async (t) => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  let refreshes = 0;
  const mounted = await mountCountdown(t, new Date(now).toISOString(), async () => {
    refreshes += 1;
  });
  assert.equal(refreshes, 1);
  for (const [delay, expected] of [
    [5_000, 2],
    [15_000, 3],
    [60_000, 4],
  ]) {
    await act(async () => {
      mounted.listeners.get("focus")();
      mounted.listeners.get("visibilitychange")();
      t.mock.timers.tick(delay - 1);
    });
    assert.equal(refreshes, expected - 1);
    await act(async () => t.mock.timers.tick(1));
    assert.equal(refreshes, expected);
  }
  await act(async () => t.mock.timers.tick(3_600_000));
  assert.equal(refreshes, 4);
  await act(async () => mounted.listeners.get("focus")());
  assert.equal(refreshes, 5);
  await act(async () => {
    mounted.listeners.get("focus")();
    mounted.listeners.get("visibilitychange")();
    t.mock.timers.tick(59_999);
    mounted.listeners.get("focus")();
  });
  assert.equal(refreshes, 5);
  await act(async () => {
    t.mock.timers.tick(1);
    mounted.listeners.get("visibilitychange")();
  });
  assert.equal(refreshes, 6);
});

test("an in-flight expiry cannot duplicate requests or retry after unmount", async (t) => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  let refreshes = 0;
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const mounted = await mountCountdown(t, new Date(now).toISOString(), () => {
    refreshes += 1;
    return pending;
  });
  await act(async () => {
    t.mock.timers.tick(300_000);
    mounted.listeners.get("focus")();
    mounted.listeners.get("visibilitychange")();
  });
  assert.equal(refreshes, 1);
  await mounted.unmount();
  await act(async () => resolve());
  await act(async () => t.mock.timers.tick(300_000));
  assert.equal(refreshes, 1);
  assert.equal(mounted.listeners.has("focus"), false);
  assert.equal(mounted.listeners.has("visibilitychange"), false);
});

test("waking after a return deadline refreshes, while missing timestamps install no timer", async (t) => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  let refreshes = 0;
  const mounted = await mountCountdown(t, new Date(now + 60_000).toISOString(), async () => {
    refreshes += 1;
  });
  await act(async () => {
    t.mock.timers.setTime(now + 3_600_000);
    mounted.listeners.get("focus")();
  });
  assert.equal(mounted.current, null);
  assert.equal(refreshes, 1);
  await mounted.render(null);
  assert.equal(mounted.listeners.has("focus"), false);
  assert.equal(mounted.listeners.has("visibilitychange"), false);
  await act(async () => t.mock.timers.tick(3_600_000));
  assert.equal(refreshes, 1);
});

test("switching accounts during an expiry request drops its response and retry", async (t) => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  t.after(async () => act(async () => setUsageAccount(null)));
  let resolve;
  const pending = new Promise((done) => {
    resolve = done;
  });
  let refreshes = 0;
  const mounted = await mountCountdown(
    t,
    null,
    () =>
      loadUsage(
        () => {
          refreshes += 1;
          return pending;
        },
        { force: true }
      ),
    function useStoredTimestamp() {
      const state = useSyncExternalStore(subscribeUsage, getUsageState);
      return state.status === "success" ? state.data.nextWordsAvailableAt : null;
    }
  );
  await act(async () => {
    setUsageAccount("old-account");
    await loadUsage(async () => ({
      wordsUsed: 2_000,
      limit: 2_000,
      nextWordsAvailableAt: new Date(now + 1_000).toISOString(),
    }));
  });
  await act(async () => t.mock.timers.tick(1_000));
  assert.equal(refreshes, 1);
  await act(async () => {
    setUsageAccount("new-account");
    await loadUsage(async () => ({ wordsUsed: 580, limit: 2_000 }));
  });
  await act(async () => resolve({ wordsUsed: 0, limit: 2_000 }));
  await act(async () => t.mock.timers.tick(300_000));
  assert.equal(getUsageState().accountId, "new-account");
  assert.equal(getUsageState().data.wordsUsed, 580);
  assert.equal(refreshes, 1);
  assert.equal(mounted.listeners.has("focus"), false);
});
