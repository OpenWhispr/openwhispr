const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const SPACE = { availableBytes: 50e9, factors: { whisper: 1.2, parakeet: 2.5, llm: 1.2 } };

async function setup(t) {
  let root = null;
  // Registered first so it runs before the globals are taken down
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  let reads = 0;
  const focusListeners = new Set();
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        async getLocalSetupSpace() {
          reads++;
          return SPACE;
        },
      },
      addEventListener: (type, listener) => type === "focus" && focusListeners.add(listener),
      removeEventListener: (type, listener) => focusListeners.delete(listener),
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-local-setup-space-" });
  const { useLocalSetupSpace } = await vite.ssrLoadModule(
    "/components/onboarding/useLocalSetupSpace.ts"
  );
  let value;
  let enabled = false;
  function Harness() {
    value = useLocalSetupSpace(enabled);
    return null;
  }
  root = createRoot(container);
  const render = async (next) => {
    enabled = next;
    await React.act(async () => root.render(React.createElement(Harness)));
  };
  return { render, reads: () => reads, focusListeners, value: () => value };
}

test("free space is read once on mount; only an enabled step re-reads on focus", async (t) => {
  const s = await setup(t);
  // Onboarding mounts on an earlier step: one read, so the figure is ready later.
  await s.render(false);
  assert.equal(s.reads(), 1);
  assert.equal(s.value().availableBytes, SPACE.availableBytes);
  assert.equal(s.focusListeners.size, 0, "focus outside the two steps does not re-read");

  // Entering setup-choice: the first render already has the value, with no new read.
  await s.render(true);
  assert.equal(s.value().availableBytes, SPACE.availableBytes);
  assert.equal(s.reads(), 1);
  assert.equal(s.focusListeners.size, 1);
  await React.act(async () => {
    for (const listener of s.focusListeners) listener();
  });
  assert.equal(s.reads(), 2, "focus on the step reads again");

  // Leaving the steps that need it stops the focus reads and keeps the last reading.
  await s.render(false);
  assert.equal(s.focusListeners.size, 0);
  assert.equal(s.value().availableBytes, SPACE.availableBytes);
});
