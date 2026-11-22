const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// What the window is told to show, render by render, as its layout changes.
test("the render that changes the layout is already hidden, before the window resizes", async (t) => {
  const layoutRequests = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        agentWindowSetLayout: async (request) => {
          layoutRequests.push(request.layout);
          return true;
        },
      },
    },
  });
  const container = installHookDom(t);
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-agent-surface-" });
  const { useAgentSurface } = await vite.ssrLoadModule("/components/agent/useAgentSurface.ts");
  const renders = [];
  function Harness({ layout }) {
    const { shown } = useAgentSurface({ visible: true, layout, focus: false });
    renders.push({ layout, shown });
    return null;
  }
  const { createRoot } = require("react-dom/client");
  const root = createRoot(container);
  const settle = () => React.act(() => new Promise((resolve) => setTimeout(resolve, 200)));

  await React.act(async () => root.render(React.createElement(Harness, { layout: "pill" })));
  await settle();
  assert.equal(renders.at(-1).shown, true, "the pill shows once the window is sized for it");

  const before = renders.length;
  await React.act(async () => root.render(React.createElement(Harness, { layout: "modal" })));
  assert.deepEqual(renders[before], { layout: "modal", shown: false });
  await settle();
  assert.deepEqual(layoutRequests, ["pill", "modal"]);
  assert.deepEqual(renders.at(-1), { layout: "modal", shown: true });
  await React.act(async () => root.unmount());
});
