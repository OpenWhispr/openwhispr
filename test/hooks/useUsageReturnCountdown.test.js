const test = require("node:test");
const assert = require("node:assert/strict");
const { act, createElement } = require("react");
const { createRoot } = require("react-dom/client");
const { useUsageReturnCountdown } = require("../../src/hooks/useUsageReturnCountdown.ts");
const { installBrowserGlobals, installHookDom } = require("../lib/rendererTestHarness");

async function mountCountdown(t, availableAt, onRefresh) {
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
    current = useUsageReturnCountdown(timestamp, onRefresh);
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
  };
}

test("deadline refreshes once, never fabricates a reset, and accepts the next return", async (t) => {
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
    t.mock.timers.tick(120_000);
  });
  assert.equal(refreshes, 1);
  await mounted.render(new Date(now + 240_000).toISOString());
  assert.deepEqual(mounted.current, { unit: "minute", count: 1 });
  await act(async () => t.mock.timers.tick(30_000));
  assert.equal(refreshes, 2);
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
