const test = require("node:test");
const assert = require("node:assert/strict");
const { act, createElement } = require("react");
const { createRoot } = require("react-dom/client");
const { useUsageReturnCountdown } = require("../../src/hooks/useUsageReturnCountdown.ts");
const { installBrowserGlobals, installHookDom } = require("../lib/rendererTestHarness");

const NOW = Date.parse("2026-09-21T12:00:00Z");
const HOUR_MS = 3_600_000;

async function mountCountdown(t, availableAt, onRefresh) {
  let root;
  t.after(async () => {
    await act(async () => root?.unmount());
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  installBrowserGlobals(t);
  root = createRoot(installHookDom(t));
  let current;
  function Harness({ availableAt }) {
    current = useUsageReturnCountdown(availableAt, onRefresh);
    return null;
  }
  const render = (value) =>
    act(async () => root.render(createElement(Harness, { availableAt: value })));
  await render(availableAt);
  return {
    get current() {
      return current;
    },
    render,
    unmount: async () => {
      await act(async () => root.unmount());
      root = null;
    },
  };
}

test("counts down each minute and refreshes once when the words return", async (t) => {
  let refreshes = 0;
  const mounted = await mountCountdown(t, NOW + 90_000, async () => {
    refreshes += 1;
  });
  assert.deepEqual(mounted.current, { unit: "minute", count: 2 });
  await act(async () => t.mock.timers.tick(60_000));
  assert.deepEqual(mounted.current, { unit: "minute", count: 1 });
  await act(async () => t.mock.timers.tick(30_000));
  assert.equal(mounted.current, null);
  assert.equal(refreshes, 1);
  await act(async () => t.mock.timers.tick(HOUR_MS));
  assert.equal(refreshes, 1);
});

test("an elapsed return time refreshes at once, and the next one restarts the countdown", async (t) => {
  let refreshes = 0;
  const mounted = await mountCountdown(t, NOW, async () => {
    refreshes += 1;
  });
  assert.equal(refreshes, 1);
  await mounted.render(NOW + 2 * HOUR_MS);
  assert.deepEqual(mounted.current, { unit: "hour", count: 2 });
  await act(async () => t.mock.timers.tick(2 * HOUR_MS));
  assert.equal(refreshes, 2);
});

test("no return time or an unmounted meter never refreshes", async (t) => {
  let refreshes = 0;
  const mounted = await mountCountdown(t, null, async () => {
    refreshes += 1;
  });
  assert.equal(mounted.current, null);
  await act(async () => t.mock.timers.tick(HOUR_MS));
  await mounted.render(Date.now() + 60_000);
  await mounted.unmount();
  await act(async () => t.mock.timers.tick(HOUR_MS));
  assert.equal(refreshes, 0);
});
