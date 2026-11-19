const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const VIEWPORT = { viewportWidth: 208, viewportHeight: 120 };
const box = (left, top, right, bottom) => ({ left, top, right, bottom });
const IDLE_PILL = box(156, 68, 196, 108);
// The idle pill plus 12px of glow room, clamped to the window's right and bottom.
const IDLE_SHAPE = { x: 144, y: 56, width: 64, height: 64, ...VIEWPORT };

async function mountPill(t, { platform = "win32", visible = true, descendants = [] } = {}) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const regions = [];
  const listeners = new Map();
  const frames = new Map();
  let nextFrame = 1;
  let mutationCallback = null;
  let visibilityListener = null;
  let measurements = 0;
  let writeRegion = async () => visible;
  let rect = IDLE_PILL;
  const pill = {
    getBoundingClientRect: () => {
      measurements += 1;
      return rect;
    },
    querySelectorAll: () =>
      descendants.map((descendant) => ({ getBoundingClientRect: descendant })),
  };
  installBrowserGlobals(t, {
    window: {
      innerWidth: VIEWPORT.viewportWidth,
      innerHeight: VIEWPORT.viewportHeight,
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type, listener) => {
        if (listeners.get(type) === listener) listeners.delete(type);
      },
      electronAPI: {
        getPlatform: () => platform,
        setMainWindowInputRegion: (region) => {
          regions.push(region);
          return writeRegion(region);
        },
        onMainWindowVisibilityChanged: (listener) => {
          visibilityListener = listener;
          return () => {
            visibilityListener = null;
          };
        },
      },
    },
  });
  const container = installHookDom(t);
  globalThis.document.hidden = false;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(nextFrame, callback);
    return nextFrame++;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const originalMutationObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      mutationCallback = this.callback;
    }
    disconnect() {
      if (mutationCallback === this.callback) mutationCallback = null;
    }
  };
  t.after(() => {
    globalThis.MutationObserver = originalMutationObserver;
  });
  const vite = await createRendererServer(t);
  const { useWindowsPillShape } = await vite.ssrLoadModule("/hooks/useWindowsPillShape.ts");
  t.mock.timers.enable({ apis: ["setInterval"] });
  let props = { pillRef: { current: pill }, captureWindow: false, pillInteractive: true };
  function Harness() {
    useWindowsPillShape(props);
    return null;
  }
  root = createRoot(container);
  const render = async (next = {}) => {
    props = { ...props, ...next };
    await React.act(async () => root.render(React.createElement(Harness)));
  };
  const frame = async (count = 1) => {
    for (let i = 0; i < count; i += 1) {
      const pending = [...frames.values()];
      frames.clear();
      await React.act(async () => pending.forEach((callback) => callback()));
    }
  };
  await render();
  return {
    regions,
    frame,
    render,
    pendingFrames: () => frames.size,
    measurements: () => measurements,
    setRect: (next) => {
      rect = next;
    },
    setRegionWriter: (writer) => {
      writeRegion = writer;
    },
    tick: async () => {
      await React.act(async () => t.mock.timers.tick(50));
    },
    wake: async (type) => {
      await React.act(async () => (type ? listeners.get(type)() : mutationCallback()));
    },
    setVisible: async (next) => {
      await React.act(async () => visibilityListener(next));
    },
    unmount: async () => {
      await React.act(async () => root.unmount());
      root = null;
    },
  };
}

test("Windows keeps the whole window until the pill holds still, then shapes it", async (t) => {
  const mounted = await mountPill(t);
  assert.deepEqual(mounted.regions, [null]);
  await mounted.frame(3);
  assert.deepEqual(mounted.regions, [null, IDLE_SHAPE]);
  assert.equal(mounted.pendingFrames(), 0);
});

test("Windows includes the tooltip and other descendants in the shape", async (t) => {
  const mounted = await mountPill(t, {
    descendants: [() => box(150, 46, 200, 64), () => box(170, 80, 170, 80)],
  });
  await mounted.frame(3);
  assert.deepEqual(mounted.regions.at(-1), {
    x: 138,
    y: 34,
    width: 70,
    height: 86,
    ...VIEWPORT,
  });
});

test("Windows gives a growing pill the whole window until it settles", async (t) => {
  const mounted = await mountPill(t);
  await mounted.frame(3);
  // A transition barely moves on its first frame.
  await mounted.wake("transitionrun");
  await mounted.frame();
  assert.deepEqual(mounted.regions, [null, IDLE_SHAPE]);
  mounted.setRect(box(150, 70, 196, 106));
  await mounted.frame();
  assert.deepEqual(mounted.regions, [null, IDLE_SHAPE, null]);
  mounted.setRect(box(98, 72, 196, 108));
  await mounted.frame(3);
  assert.deepEqual(mounted.regions, [
    null,
    IDLE_SHAPE,
    null,
    { x: 86, y: 60, width: 122, height: 60, ...VIEWPORT },
  ]);
});

test("Windows watches DOM changes and window resizes, and ignores changes inside the shape", async (t) => {
  const mounted = await mountPill(t);
  await mounted.frame(3);
  // A DOM change is measured at once and then for three frames.
  for (const [type, count] of [
    [undefined, 4],
    ["resize", 3],
    ["animationstart", 3],
  ]) {
    const before = mounted.measurements();
    await mounted.wake(type);
    await mounted.frame(3);
    assert.equal(mounted.measurements() - before, count, type ?? "mutation");
  }
  assert.deepEqual(mounted.regions, [null, IDLE_SHAPE]);
  assert.equal(mounted.pendingFrames(), 0);
});

test("Windows restores the whole window before a DOM change paints", async (t) => {
  const mounted = await mountPill(t);
  await mounted.frame(3);
  // The tooltip mounts at full opacity above the shape.
  mounted.setRect(box(150, 46, 200, 108));
  await mounted.wake();
  assert.deepEqual(mounted.regions, [null, IDLE_SHAPE, null]);
});

test("Windows keeps the whole window while a resize mask carries the pill out of view", async (t) => {
  const mounted = await mountPill(t);
  await mounted.frame(3);
  mounted.setRect(box(188, 236, 228, 276));
  await mounted.wake();
  await mounted.frame(3);
  assert.deepEqual(mounted.regions.slice(2), [
    null,
    { x: 0, y: 0, width: 0, height: 0, ...VIEWPORT },
  ]);
  mounted.setRect(IDLE_PILL);
  await mounted.tick();
  await mounted.frame(3);
  assert.deepEqual(mounted.regions.slice(4), [null, IDLE_SHAPE]);
});

test("Windows resends a still shape on the interval so main can repair it", async (t) => {
  const mounted = await mountPill(t);
  await mounted.frame(3);
  await mounted.tick();
  assert.deepEqual(mounted.regions, [null, IDLE_SHAPE, IDLE_SHAPE]);
  mounted.setRect(box(100, 68, 140, 108));
  await mounted.tick();
  assert.deepEqual(mounted.regions.at(-1), null);
});

test("Windows pauses while the window is hidden and resumes when main reports it shown", async (t) => {
  // At launch the first sample reaches main before the window is shown.
  const mounted = await mountPill(t, { visible: false });
  assert.deepEqual(mounted.regions, [null]);
  await mounted.frame(3);
  await mounted.tick();
  assert.deepEqual(mounted.regions, [null]);

  mounted.setRegionWriter(async () => true);
  await mounted.setVisible(true);
  await mounted.frame(3);
  assert.deepEqual(mounted.regions, [null, null, IDLE_SHAPE]);

  await mounted.setVisible(false);
  mounted.setRect(box(98, 72, 196, 108));
  await mounted.frame(3);
  await mounted.tick();
  assert.equal(mounted.regions.length, 3);
  await mounted.setVisible(true);
  await mounted.frame(3);
  assert.deepEqual(mounted.regions.slice(3), [
    null,
    { x: 86, y: 60, width: 122, height: 60, ...VIEWPORT },
  ]);
});

test("Windows ignores a hidden reply from before the window was shown again", async (t) => {
  const mounted = await mountPill(t);
  await mounted.frame(3);
  let replyHidden;
  mounted.setRegionWriter(
    () =>
      new Promise((resolve) => {
        replyHidden = () => resolve(false);
      })
  );
  mounted.setRect(box(98, 72, 196, 108));
  await mounted.tick();
  mounted.setRegionWriter(async () => true);
  await mounted.setVisible(true);
  await React.act(async () => replyHidden());
  await mounted.frame(3);
  assert.deepEqual(mounted.regions.at(-1), {
    x: 86,
    y: 60,
    width: 122,
    height: 60,
    ...VIEWPORT,
  });
});

test("Windows stops shaping after main rejects a region, until the window shows again", async (t) => {
  const mounted = await mountPill(t);
  await mounted.frame(3);
  mounted.setRegionWriter(() => Promise.reject(new Error("Invalid input region")));
  await mounted.tick();
  const rejected = mounted.regions.length;
  mounted.setRect(box(98, 72, 196, 108));
  await mounted.tick();
  await mounted.frame(3);
  assert.equal(mounted.regions.length, rejected);
  assert.equal(mounted.pendingFrames(), 0);

  mounted.setRegionWriter(async () => true);
  await mounted.setVisible(true);
  await mounted.frame(3);
  assert.deepEqual(mounted.regions.slice(rejected), [
    null,
    { x: 86, y: 60, width: 122, height: 60, ...VIEWPORT },
  ]);
});

test("Windows uses the whole window for overlays and a suppressed pill", async (t) => {
  const mounted = await mountPill(t);
  await mounted.frame(3);
  await mounted.render({ captureWindow: true });
  assert.deepEqual(mounted.regions.slice(2), [null, null]);
  assert.equal(mounted.pendingFrames(), 0);
  await mounted.tick();
  assert.equal(mounted.regions.length, 4);
  await mounted.render({ captureWindow: false, pillInteractive: false });
  assert.deepEqual(mounted.regions.slice(4), [null, null]);
  await mounted.unmount();
  assert.deepEqual(mounted.regions.at(-1), null);
});

for (const platform of ["darwin", "linux"]) {
  test(`${platform} leaves the window shape alone`, async (t) => {
    const mounted = await mountPill(t, { platform });
    await mounted.frame(3);
    await mounted.tick();
    await mounted.unmount();
    assert.deepEqual(mounted.regions, []);
    assert.equal(mounted.measurements(), 0);
  });
}
