const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

// The control panel runs with backgroundThrottling off, so a hidden or minimized window
// still reports itself visible and never fires visibilitychange; it does lose focus.
test("the lawn rests while the window is in the background", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const windowListeners = new Map();
  installBrowserGlobals(t, {
    window: {
      addEventListener(type, listener) {
        windowListeners.set(type, listener);
      },
      removeEventListener(type, listener) {
        if (windowListeners.get(type) === listener) windowListeners.delete(type);
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-touch-grass-resting-test-",
  });
  const { default: TouchGrass } = await vite.ssrLoadModule("/components/TouchGrass.tsx");

  let hushes = 0;
  const rustle = { brush() {}, hush: () => (hushes += 1), dispose() {} };
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(TouchGrass, { rustle, height: 240, label: "Grass", onExit() {} })
    )
  );
  const scene = findElement(container, (element) => element.getAttribute("role") === "application");
  const isResting = () => /\btouch-grass--resting\b/.test(scene.getAttribute("class"));
  assert.equal(isResting(), false);

  await React.act(async () => windowListeners.get("blur")());
  assert.equal(hushes, 1, "the rustle falls silent");
  assert.equal(isResting(), true, "the breeze stops");

  await React.act(async () => windowListeners.get("focus")());
  assert.equal(isResting(), false);

  await React.act(async () => root.unmount());
  root = null;
  assert.equal(windowListeners.has("blur"), false);
  assert.equal(windowListeners.has("focus"), false);
});
