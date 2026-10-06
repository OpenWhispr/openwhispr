const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const PILL_RECT = { x: 156, y: 68, width: 40, height: 40 };
const VIEWPORT = { viewportWidth: 208, viewportHeight: 120 };
const EMPTY_REGION = { x: 0, y: 0, width: 0, height: 0, ...VIEWPORT };

async function mountPill(t, { platform = "linux", visible = true } = {}) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const regions = [];
  let measurements = 0;
  let visibilityListener;
  let writeRegion = async () => visible;
  let rect = PILL_RECT;
  const pill = {
    getBoundingClientRect: () => {
      measurements += 1;
      return rect;
    },
  };
  const pillRef = { current: pill };
  installBrowserGlobals(t, {
    window: {
      innerWidth: VIEWPORT.viewportWidth,
      innerHeight: VIEWPORT.viewportHeight,
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
  const vite = await createRendererServer(t);
  const { useLinuxPillInteractivity } = await vite.ssrLoadModule(
    "/hooks/useLinuxPillInteractivity.ts"
  );
  t.mock.timers.enable({ apis: ["setInterval"] });
  let props = { pillRef, captureWindow: false, pillInteractive: true };
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
    regions,
    setRect: (next) => {
      rect = next;
    },
    setPillPresent: (present) => {
      pillRef.current = present ? pill : null;
    },
    setRegionWriter: (writer) => {
      writeRegion = writer;
    },
    measurements: () => measurements,
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

test("Linux measures the rendered pill and follows cancel emergence, docking and viewport changes", async (t) => {
  const mounted = await mountPill(t);
  assert.deepEqual(mounted.regions, [{ ...PILL_RECT, ...VIEWPORT }]);

  const expanded = { x: 62.5, y: 72, width: 133.5, height: 36 };
  mounted.setRect(expanded);
  await mounted.tick();
  assert.deepEqual(mounted.regions.at(-1), { ...expanded, ...VIEWPORT });

  const docked = { x: 12, y: 452.25, width: 98, height: 36 };
  mounted.setRect(docked);
  globalThis.window.innerWidth = 400;
  globalThis.window.innerHeight = 500;
  await mounted.tick();
  assert.deepEqual(mounted.regions.at(-1), {
    ...docked,
    viewportWidth: 400,
    viewportHeight: 500,
  });
});

test("unchanged geometry is reapplied because native resizes can reset the input region", async (t) => {
  const mounted = await mountPill(t);
  await mounted.tick();
  assert.deepEqual(mounted.regions, [
    { ...PILL_RECT, ...VIEWPORT },
    { ...PILL_RECT, ...VIEWPORT },
  ]);
});

test("controls and dragging request full input immediately despite an older pending region", async (t) => {
  const mounted = await mountPill(t);
  const pending = Promise.withResolvers();
  mounted.setRegionWriter((region) => (region ? pending.promise : Promise.resolve(true)));
  await mounted.tick();
  await mounted.render({ captureWindow: true });
  assert.equal(mounted.regions.at(-1), null);
  const writes = mounted.regions.length;
  const measurements = mounted.measurements();
  await mounted.tick();
  assert.equal(mounted.regions.length, writes);
  assert.equal(mounted.measurements(), measurements);

  await React.act(async () => pending.resolve(true));
  assert.equal(mounted.regions.at(-1), null);
  await mounted.render({ captureWindow: false });
  assert.deepEqual(mounted.regions.at(-1), { ...PILL_RECT, ...VIEWPORT });
});

test("suppressed and absent pills request an empty region while overlays keep full input", async (t) => {
  const mounted = await mountPill(t);
  await mounted.render({ pillInteractive: false });
  assert.deepEqual(mounted.regions.at(-1), EMPTY_REGION);
  await mounted.render({ captureWindow: true });
  assert.equal(mounted.regions.at(-1), null);

  mounted.setPillPresent(false);
  await mounted.render({ captureWindow: false, pillInteractive: true });
  assert.deepEqual(mounted.regions.at(-1), EMPTY_REGION);
  mounted.setPillPresent(true);
  await mounted.tick();
  assert.deepEqual(mounted.regions.at(-1), { ...PILL_RECT, ...VIEWPORT });
});

test("only one measurement update is pending and the next sample uses current geometry", async (t) => {
  const mounted = await mountPill(t);
  const pending = Promise.withResolvers();
  mounted.setRegionWriter(() => pending.promise);
  await mounted.tick();
  const writes = mounted.regions.length;
  const measurements = mounted.measurements();
  mounted.setRect({ x: 12, y: 72, width: 134, height: 36 });
  await mounted.tick();
  assert.equal(mounted.regions.length, writes);
  assert.equal(mounted.measurements(), measurements);

  await React.act(async () => pending.resolve(true));
  await mounted.tick();
  assert.deepEqual(mounted.regions.at(-1), {
    x: 12,
    y: 72,
    width: 134,
    height: 36,
    ...VIEWPORT,
  });
});

test("native hide stops sampling across prop changes and show applies the current region", async (t) => {
  const mounted = await mountPill(t);
  await mounted.setVisible(false);
  const writes = mounted.regions.length;
  await mounted.tick();
  assert.equal(mounted.regions.length, writes);
  assert.equal(globalThis.document.hidden, false);

  await mounted.render({ pillInteractive: false });
  assert.equal(mounted.regions.at(-1), null, "effect cleanup releases its previous region");
  const hiddenWrites = mounted.regions.length;
  await mounted.tick();
  assert.equal(mounted.regions.length, hiddenWrites);
  await mounted.setVisible(true);
  assert.deepEqual(mounted.regions.at(-1), EMPTY_REGION);
});

test("an initially hidden window stops after one update until native show", async (t) => {
  const mounted = await mountPill(t, { visible: false });
  assert.equal(mounted.regions.length, 1);
  await mounted.tick();
  assert.equal(mounted.regions.length, 1);

  await mounted.render({ pillInteractive: false });
  assert.equal(mounted.regions.at(-1), null);
  const writes = mounted.regions.length;
  await mounted.tick();
  assert.equal(mounted.regions.length, writes);

  mounted.setRegionWriter(async () => true);
  await mounted.setVisible(true);
  assert.deepEqual(mounted.regions.at(-1), EMPTY_REGION);
});

test("a region failure stops sampling and a later show starts a fresh update", async (t) => {
  const mounted = await mountPill(t);
  mounted.setRegionWriter(async () => {
    throw new Error("native input shaping unavailable");
  });
  await mounted.tick();
  const writes = mounted.regions.length;
  mounted.setRegionWriter(async () => true);
  await mounted.tick();
  assert.equal(mounted.regions.length, writes);
  await mounted.setVisible(true);
  assert.equal(mounted.regions.length, writes + 1);
  assert.deepEqual(mounted.regions.at(-1), { ...PILL_RECT, ...VIEWPORT });
});

test("an old rejected update cannot stop a new effect's sampling", async (t) => {
  const mounted = await mountPill(t);
  const pending = Promise.withResolvers();
  mounted.setRegionWriter(() => pending.promise);
  await mounted.tick();
  mounted.setRegionWriter(async () => true);
  await mounted.render({ pillInteractive: false });
  await React.act(async () => pending.reject(new Error("old update failed")));
  const writes = mounted.regions.length;
  await mounted.tick();
  assert.equal(mounted.regions.length, writes + 1);
  assert.deepEqual(mounted.regions.at(-1), EMPTY_REGION);
});

test("an old rejected update cannot stop sampling after native hide and show", async (t) => {
  const mounted = await mountPill(t);
  const pending = Promise.withResolvers();
  mounted.setRegionWriter(() => pending.promise);
  await mounted.tick();
  await mounted.setVisible(false);
  await mounted.setVisible(true);
  mounted.setRegionWriter(async () => true);
  await React.act(async () => pending.reject(new Error("hidden update failed")));
  const writes = mounted.regions.length;
  await mounted.tick();
  assert.equal(mounted.regions.length, writes + 1);
  assert.deepEqual(mounted.regions.at(-1), { ...PILL_RECT, ...VIEWPORT });
});

test("an old hidden response cannot suspend sampling after native show", async (t) => {
  const mounted = await mountPill(t);
  const pending = Promise.withResolvers();
  mounted.setRegionWriter(() => pending.promise);
  await mounted.tick();
  await mounted.setVisible(false);
  await mounted.setVisible(true);
  mounted.setRegionWriter(async () => true);
  await React.act(async () => pending.resolve(false));
  const writes = mounted.regions.length;
  await mounted.tick();
  assert.equal(mounted.regions.length, writes + 1);
  assert.deepEqual(mounted.regions.at(-1), { ...PILL_RECT, ...VIEWPORT });
});

test("unmount queues full input after a pending narrow region and silences later failures", async (t) => {
  const mounted = await mountPill(t);
  const pending = Promise.withResolvers();
  mounted.setRegionWriter((region) => (region ? pending.promise : Promise.resolve(true)));
  await mounted.tick();
  await mounted.unmount();
  assert.deepEqual(mounted.regions.slice(-2), [{ ...PILL_RECT, ...VIEWPORT }, null]);
  const writes = mounted.regions.length;
  await React.act(async () => pending.reject(new Error("unmounted update failed")));
  await mounted.tick();
  assert.equal(mounted.regions.length, writes);
});

for (const platform of ["darwin", "win32"]) {
  test(`${platform} keeps its native interactivity implementation`, async (t) => {
    const mounted = await mountPill(t, { platform });
    await mounted.render({ captureWindow: true });
    await mounted.tick();
    await mounted.unmount();
    assert.deepEqual(mounted.regions, []);
    assert.equal(mounted.measurements(), 0);
  });
}
