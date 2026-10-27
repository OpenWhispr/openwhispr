const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("billing return uses committed callbacks, survives unmount, and rearming replaces the bounded watch", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const focus = new Set();
  const timers = new Map();
  const delays = [];
  let timerId = 0;
  installBrowserGlobals(t, {
    window: {
      addEventListener: (event, listener) => {
        if (event === "focus") focus.add(listener);
      },
      removeEventListener: (event, listener) => {
        if (event === "focus") focus.delete(listener);
      },
    },
  });
  const container = installHookDom(t);
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;

  t.after(() => {
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClear;
  });
  const vite = await createRendererServer(t);
  const { useBillingRefreshOnReturn } = await vite.ssrLoadModule(
    "/hooks/useBillingRefreshOnReturn.ts"
  );
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (![4000, 8000, 16000].includes(delay)) return originalTimeout(callback, delay, ...args);
    delays.push(delay);
    timers.set(++timerId, callback);
    return timerId;
  };
  globalThis.clearTimeout = (id) => {
    if (timers.has(id)) timers.delete(id);
    else originalClear(id);
  };
  const calls = [];
  let arm;
  const never = new Promise(() => {});
  function Owner({ label, suspend }) {
    const arming = useBillingRefreshOnReturn(() => calls.push(label));
    if (suspend) throw never;
    arm = arming;
    return null;
  }
  root = createRoot(container);
  const render = (label, suspend = false) =>
    React.act(async () =>
      root.render(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(
            React.Suspense,
            { fallback: null },
            React.createElement(Owner, { label, suspend })
          )
        )
      )
    );
  await render("A");
  arm();
  await render("B");
  await render("uncommitted", true);
  // Mimic the browser's once:true focus dispatch.
  function returnFocus() {
    const listeners = [...focus];
    focus.clear();
    for (const listener of listeners) listener();
  }
  returnFocus();
  assert.deepEqual(calls, ["B"]);
  assert.deepEqual(delays, [4000, 8000, 16000]);
  await render("C");
  for (const callback of timers.values()) callback();
  timers.clear();
  assert.deepEqual(calls, ["B", "C", "C", "C"]);
  arm();
  arm();
  assert.equal(focus.size, 1);
  returnFocus();
  assert.equal(timers.size, 3);
  arm();
  assert.equal(timers.size, 0, "new watch cancels old backoff");
  await React.act(async () => root.render(null));
  returnFocus();
  for (const callback of timers.values()) callback();
  assert.deepEqual(calls.slice(-4), ["C", "C", "C", "C"]);
});
