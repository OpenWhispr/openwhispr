const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Drives the hook the way the pill window does: main reports a hold ending,
// the recording hook reports a finished run, and App reports whether the pill
// is at rest. Timers are left real; auto-dismiss is covered by the card's
// countdown, not asserted here.
async function mountHook(t, { initialStorage } = {}) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const listeners = {};
  const { storage } = installBrowserGlobals(t, {
    initialStorage,
    window: {
      electronAPI: {
        onHoldDictationEnded: (callback) => {
          listeners.holdEnded = callback;
          return () => {};
        },
        onHandsFreeLatched: (callback) => {
          listeners.latched = callback;
          return () => {};
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-hands-free-tip-hook-test-",
  });
  const { useHandsFreeTip } = await vite.ssrLoadModule("/hooks/useHandsFreeTip.js");

  let props = { completedRuns: 0, recording: false, atRest: true };
  let result;
  function Harness() {
    result = useHandsFreeTip(props);
    return null;
  }
  root = createRoot(container);
  const render = async (next = {}) => {
    props = { ...props, ...next };
    await React.act(async () => {
      root.render(React.createElement(Harness));
    });
  };
  const emit = async (name, payload) => {
    await React.act(async () => {
      listeners[name]?.(payload);
    });
  };
  await render();
  return { render, emit, tip: () => result, storage };
}

test("a two-minute hold earns the tip once its run completes and the pill rests", async (t) => {
  const { render, emit, tip, storage } = await mountHook(t);

  await render({ atRest: false });
  await emit("holdEnded", { inputKind: "translation", heldMs: 120000 });
  assert.equal(tip().visible, false, "nothing shows while still processing");

  await render({ completedRuns: 1, atRest: true });
  assert.equal(tip().visible, true);
  assert.equal(tip().inputKind, "translation");
  assert.equal(storage.getItem("handsFreeTipShownCount"), "1");
});

test("a short hold shows nothing", async (t) => {
  const { render, emit, tip } = await mountHook(t);

  await render({ atRest: false });
  await emit("holdEnded", { inputKind: "dictation", heldMs: 45000 });
  await render({ completedRuns: 1, atRest: true });

  assert.equal(tip().visible, false);
});

test("the tip waits for the pill to rest before showing", async (t) => {
  const { render, emit, tip } = await mountHook(t);

  await render({ atRest: false });
  await emit("holdEnded", { inputKind: "assistant", heldMs: 130000 });
  await render({ completedRuns: 1, atRest: false });
  assert.equal(tip().visible, false, "the agent panel still owns the window");

  await render({ atRest: true });
  assert.equal(tip().visible, true);
});

test("a hold whose run never completes does not leak into the next tap session", async (t) => {
  const { render, emit, tip } = await mountHook(t);

  await render({ recording: true, atRest: false });
  await emit("holdEnded", { inputKind: "dictation", heldMs: 130000 });
  await render({ recording: false, atRest: true });
  await render({ recording: true, atRest: false });
  await render({ recording: false, completedRuns: 1, atRest: true });

  assert.equal(tip().visible, false);
});

test("dismissing hides the tip", async (t) => {
  const { render, emit, tip } = await mountHook(t);

  await render({ atRest: false });
  await emit("holdEnded", { inputKind: "dictation", heldMs: 130000 });
  await render({ completedRuns: 1, atRest: true });
  assert.equal(tip().visible, true);

  await React.act(async () => tip().dismiss());
  assert.equal(tip().visible, false);
});

test("latching hands-free retires the tip for good", async (t) => {
  const { render, emit, tip, storage } = await mountHook(t);

  await emit("latched", { inputKind: "dictation" });
  assert.equal(storage.getItem("handsFreeUsed"), "true");

  await render({ atRest: false });
  await emit("holdEnded", { inputKind: "dictation", heldMs: 130000 });
  await render({ completedRuns: 1, atRest: true });
  assert.equal(tip().visible, false);
});
