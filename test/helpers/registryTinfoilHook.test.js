const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

for (const hasLiveOverlay of [false, true]) {
  test(`an open Tinfoil picker ${hasLiveOverlay ? "preserves its confirmed live list" : "receives a signed catalog update while offline"}`, async (t) => {
    const live = [{ id: "live-only", name: "Live", description: "Fixture" }];
    installBrowserGlobals(t, {
      initialStorage: hasLiveOverlay
        ? { tinfoilModels: JSON.stringify({ models: live, fetchedAt: Date.now() }) }
        : {},
    });
    globalThis.window.electronAPI.getTinfoilChatModels = async () => {
      throw new Error("offline fixture");
    };
    const container = installHookDom(t);
    const vite = await createRendererServer(t, {
      cachePrefix: "registry-tinfoil-hook-",
      mockModules: { "/utils/logger": "export default {debug(){},info(){},warn(){},error(){}};" },
    });
    const { useTinfoilModels } = await vite.ssrLoadModule("/hooks/useTinfoilModels.ts");
    const store = await vite.ssrLoadModule("/models/registryData.js");
    const React = require("react");
    const { createRoot } = require("react-dom/client");
    const root = createRoot(container);
    let result;
    function Picker() {
      result = useTinfoilModels(true);
      return null;
    }
    try {
      await React.act(async () => root.render(React.createElement(Picker)));
      if (!hasLiveOverlay) assert.equal(result.error, "offline fixture");
      const data = structuredClone(store.getRegistryData());
      data.cloudProviders
        .find((p) => p.id === "tinfoil")
        .models.push({ id: "signed-new", name: "New", description: "Fixture" });
      await React.act(async () =>
        store.replaceRegistryData({ data, manifestVersion: store.getRegistryVersion() + 1 })
      );
      assert.equal(
        result.models.some((m) => m.id === "signed-new"),
        !hasLiveOverlay
      );
      if (hasLiveOverlay)
        assert.deepEqual(
          result.models.map((m) => m.id),
          ["live-only"]
        );
    } finally {
      await React.act(async () => root.unmount());
    }
  });
}
