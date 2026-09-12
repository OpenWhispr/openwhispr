const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

async function mountPill(t, { platform = "linux" } = {}) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const captures = [];
  const hovers = [];
  const hitPoints = [];
  let pointerReads = 0;
  let visibilityListener;
  let readPointer = async () => ({ x: 104, y: 60 });
  const pill = {};
  const cancel = {};
  const padding = {};
  let hit = padding;
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getPlatform: () => platform,
        getMainWindowPointerPosition: () => {
          pointerReads += 1;
          return readPointer();
        },
        setMainWindowInteractivity: async (capture) => captures.push(capture),
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
  globalThis.document.elementFromPoint = (x, y) => {
    hitPoints.push({ x, y });
    return hit;
  };
  const vite = await createRendererServer(t);
  const { useLinuxPillInteractivity } = await vite.ssrLoadModule(
    "/hooks/useLinuxPillInteractivity.ts"
  );
  t.mock.timers.enable({ apis: ["setInterval"] });
  let props = {
    pillRef: { current: { contains: (element) => element === pill || element === cancel } },
    captureWindow: false,
    pillInteractive: true,
    onHoverChange: (hovered) => hovers.push(hovered),
  };
  function Harness() {
    useLinuxPillInteractivity(props);
    return null;
  }
  root = createRoot(container);
  const render = async (next = {}) => {
    props = { ...props, ...next };
    await React.act(async () => root.render(React.createElement(Harness)));
  };
  const tick = async () => {
    await React.act(async () => t.mock.timers.tick(50));
  };
  await render();
  return {
    captures,
    hovers,
    hitPoints,
    pill,
    cancel,
    padding,
    setHit: (element) => {
      hit = element;
    },
    setPointerReader: (reader) => {
      readPointer = reader;
    },
    pointerReads: () => pointerReads,
    setVisible: async (visible) => {
      await React.act(async () => visibilityListener(visible));
    },
    render,
    tick,
    unmount: async () => {
      await React.act(async () => root.unmount());
      root = null;
    },
  };
}

test("Linux recovers every hover without native mouse events and releases transparent padding", async (t) => {
  const mounted = await mountPill(t);
  assert.equal(mounted.captures.at(-1), false);
  for (const target of [mounted.pill, mounted.cancel, mounted.padding, mounted.pill]) {
    mounted.setHit(target);
    await mounted.tick();
    const inside = target !== mounted.padding;
    assert.equal(mounted.captures.at(-1), inside);
    assert.equal(mounted.hovers.at(-1), inside);
  }
  assert.deepEqual(mounted.hitPoints.at(-1), { x: 104, y: 60 });
});

test("menus, error cards, panels and dragging retain capture without waiting for a pointer read", async (t) => {
  const mounted = await mountPill(t);
  mounted.setPointerReader(() => new Promise(() => {}));
  await mounted.render({ captureWindow: true });
  assert.equal(mounted.captures.at(-1), true);
  const reads = mounted.pointerReads();
  await mounted.tick();
  assert.equal(mounted.pointerReads(), reads);
});

test("suppressed pill and hidden windows do not gain hover or capture", async (t) => {
  const mounted = await mountPill(t);
  mounted.setHit(mounted.pill);
  await mounted.render({ pillInteractive: false });
  assert.equal(mounted.captures.at(-1), false);
  assert.equal(mounted.hovers.at(-1), false);
  globalThis.document.hidden = true;
  const reads = mounted.pointerReads();
  await mounted.tick();
  assert.equal(mounted.pointerReads(), reads);
  globalThis.document.hidden = false;
  mounted.setPointerReader(async () => null);
  const captures = mounted.captures.length;
  await mounted.tick();
  assert.equal(mounted.captures.length, captures);
});

test("late pointer replies cannot disable newly opened controls or outlive unmount", async (t) => {
  const mounted = await mountPill(t);
  let finishRead;
  mounted.setPointerReader(
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      })
  );
  await mounted.tick();
  const reads = mounted.pointerReads();
  await mounted.tick();
  assert.equal(mounted.pointerReads(), reads, "only one pointer read may be in flight");
  await mounted.render({ captureWindow: true });
  await React.act(async () => finishRead({ x: 104, y: 60 }));
  assert.equal(mounted.captures.at(-1), true);
  await mounted.render({ captureWindow: false });
  await mounted.unmount();
  const captures = mounted.captures.length;
  await React.act(async () => finishRead({ x: 104, y: 60 }));
  await mounted.tick();
  assert.equal(mounted.captures.length, captures);
});

test("a rejected pointer query is retried on the next poll", async (t) => {
  const mounted = await mountPill(t);
  mounted.setPointerReader(async () => {
    throw new Error("renderer reloading");
  });
  await mounted.tick();
  mounted.setPointerReader(async () => ({ x: 150, y: 80 }));
  mounted.setHit(mounted.pill);
  await mounted.tick();
  assert.equal(mounted.captures.at(-1), true);
});

test("native hide suspends polling even when Chromium stays visible, and show samples immediately", async (t) => {
  const mounted = await mountPill(t);
  mounted.setHit(mounted.pill);
  await mounted.tick();
  let finishRead;
  mounted.setPointerReader(
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      })
  );
  await mounted.tick();
  await mounted.setVisible(false);
  assert.equal(mounted.hovers.at(-1), false);
  const captures = mounted.captures.length;
  const reads = mounted.pointerReads();
  await React.act(async () => finishRead({ x: 104, y: 60 }));
  await mounted.tick();
  assert.equal(mounted.captures.length, captures);
  assert.equal(mounted.pointerReads(), reads);
  mounted.setPointerReader(async () => ({ x: 104, y: 60 }));
  await mounted.setVisible(true);
  assert.equal(mounted.pointerReads(), reads + 1);
  assert.equal(mounted.hovers.at(-1), true);
  assert.equal(mounted.captures.at(-1), true);
});

test("a hidden native window stops polling until the next show", async (t) => {
  const mounted = await mountPill(t);
  mounted.setPointerReader(async () => null);
  await mounted.tick();
  const reads = mounted.pointerReads();
  await mounted.tick();
  assert.equal(mounted.pointerReads(), reads);
  mounted.setPointerReader(async () => ({ x: 104, y: 60 }));
  await mounted.setVisible(true);
  assert.equal(mounted.pointerReads(), reads + 1);
});

test("an old hidden-window reply cannot stop polling after the window reopens", async (t) => {
  const mounted = await mountPill(t);
  let finishRead;
  mounted.setPointerReader(
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      })
  );
  await mounted.tick();
  await mounted.setVisible(false);
  await mounted.setVisible(true);
  await React.act(async () => finishRead(null));
  mounted.setPointerReader(async () => ({ x: 104, y: 60 }));
  mounted.setHit(mounted.pill);
  await mounted.tick();
  assert.equal(mounted.captures.at(-1), true);
  assert.equal(mounted.hovers.at(-1), true);
});

test("closing controls restores click-through when the pointer is over padding", async (t) => {
  const mounted = await mountPill(t);
  await mounted.render({ captureWindow: true });
  assert.equal(mounted.captures.at(-1), true);
  await mounted.render({ captureWindow: false });
  assert.equal(mounted.captures.at(-1), false);
});

for (const platform of ["darwin", "win32"]) {
  test(`${platform} keeps native hover handling`, async (t) => {
    const mounted = await mountPill(t, { platform });
    await mounted.render({ captureWindow: true });
    await mounted.tick();
    assert.deepEqual(mounted.captures, []);
    assert.equal(mounted.pointerReads(), 0);
  });
}
