const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const modelRegistryData = require("../../src/models/modelRegistryData.json");

// The one-shot byok → mode migrations decide "local" from a provider list. That
// list used to be hand-maintained and missed `liquidai` when LFM landed
// (#1176), so a legacy LFM selection would have migrated to `providers`. Every
// registry local provider must classify as local in both migrations.
test("provider migrations classify every registry local provider as local", async (t) => {
  const localProviderIds = modelRegistryData.localProviders.map((provider) => provider.id);
  assert.ok(localProviderIds.includes("liquidai"), "the regression case must be in the registry");

  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-local-provider-migration-test-",
  });

  for (const providerId of localProviderIds) {
    storage.clear();
    storage.setItem("cloudReasoningMode", "byok");
    storage.setItem("reasoningProvider", providerId);
    storage.setItem("cloudAgentMode", "byok");
    storage.setItem("agentProvider", providerId);

    // Each migration runs once per module evaluation, so re-evaluate the store per provider.
    vite.moduleGraph.invalidateAll();
    const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
    const state = useSettingsStore.getState();

    assert.equal(state.cleanupMode, "local", `${providerId}: cleanupMode`);
    assert.equal(state.chatAgentMode, "local", `${providerId}: chatAgentMode`);
  }
});
