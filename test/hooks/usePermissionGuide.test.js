const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a helper open superseded by the next Enable click does not disable the guide", async (t) => {
  // Main answers false to an open it tore down for a newer session. Latching
  // guide.error on that would drop every later Enable click to the legacy flow.
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const opens = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        openPermissionGuide: () =>
          new Promise((resolve) => {
            opens.push(resolve);
          }),
        closePermissionGuide: async () => true,
        onPermissionGuideAction: () => () => {},
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "permission-guide-hook-" });
  const { usePermissionGuide } = await vite.ssrLoadModule(
    "/components/onboarding/usePermissionGuide.ts"
  );
  const row = (id) => ({
    id,
    granted: false,
    request: async () => {},
    check: async () => ({ granted: false }),
    openSettings: async () => {},
  });
  let guide;
  function Harness() {
    guide = usePermissionGuide({
      enabled: true,
      progress: null,
      save: () => {},
      rows: [row("accessibility"), row("microphone")],
    });
    return null;
  }
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  let first;
  await React.act(async () => {
    first = guide.start("accessibility");
    await tick();
  });
  let second;
  await React.act(async () => {
    second = guide.start("microphone");
    await tick();
    opens[0](false);
    opens[1](true);
    await Promise.all([first, second]);
  });

  assert.equal(opens.length, 2);
  assert.equal(guide.error, false);
});
