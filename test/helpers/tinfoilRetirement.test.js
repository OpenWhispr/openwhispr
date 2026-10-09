const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const flash = {
  id: "glm-5-3-flash",
  name: "GLM-5.3 Flash",
  description: "",
  supportsThinking: true,
};
const glm = { ...flash, id: "glm-5-3", name: "GLM-5.3" };
const other = { ...flash, id: "deepseek-v4-1-flash", name: "DeepSeek V4.1 Flash" };
const markers = {
  _llmScopeKeysMigrated: "1",
  _retiredTinfoilModelsMigrated: "1",
  _retiredTinfoilModelsMigrated2: "1",
};

test("all configured scopes migrate offline once, including upgrades with both older markers", async (t) => {
  const { INFERENCE_SCOPES } = await import("../../src/config/inferenceScopes.ts");
  const scopes = Object.values(INFERENCE_SCOPES);
  const initialStorage = { ...markers };
  for (const { storeKeys } of scopes) {
    initialStorage[storeKeys.provider] = "tinfoil";
    initialStorage[storeKeys.model] = flash.id;
    initialStorage[storeKeys.mode] = "providers";
  }
  const { storage } = installBrowserGlobals(t, { initialStorage });
  const vite = await createRendererServer(t);
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  for (const { storeKeys } of scopes) {
    assert.equal(useSettingsStore.getState()[storeKeys.model], glm.id);
    assert.equal(storage.getItem(storeKeys.model), glm.id);
  }
  assert.equal(storage.getItem("_retiredTinfoilModelsMigrated3"), "1");
  const { consumeTinfoilModelSwitches } = await vite.ssrLoadModule(
    "/stores/tinfoilModelSwitchStore.ts"
  );
  assert.deepEqual(consumeTinfoilModelSwitches(), [{ from: flash.name, to: glm.name }]);
  const restart = await createRendererServer(t);
  await restart.ssrLoadModule("/stores/settingsStore.ts");
  const notice = await restart.ssrLoadModule("/stores/tinfoilModelSwitchStore.ts");
  assert.deepEqual(notice.consumeTinfoilModelSwitches(), []);
});

for (const cachedModels of [[flash], [other, flash], [other, flash, glm]]) {
  test(`cleans fresh cache ${cachedModels.map((m) => m.id)} without renewing it, across windows`, async (t) => {
    const fetchedAt = Date.now() - 1000;
    const { storage } = installBrowserGlobals(t, {
      initialStorage: {
        ...markers,
        tinfoilModels: JSON.stringify({ models: cachedModels, fetchedAt }),
        cleanupProvider: "tinfoil",
        cleanupModel: flash.id,
        cleanupMode: "providers",
      },
    });
    for (let windowIndex = 0; windowIndex < 2; windowIndex++) {
      const vite = await createRendererServer(t);
      const registry = await vite.ssrLoadModule("/models/ModelRegistry.ts");
      const models = await vite.ssrLoadModule("/models/tinfoilModels.ts");
      const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
      const refreshed = await models.refreshTinfoilModels(); // no IPC/network mock available
      assert.ok(!refreshed.some((m) => m.id === flash.id));
      assert.ok(registry.getTinfoilModels().some((m) => m.id === glm.id));
      assert.equal(settings.getSettings().cleanupModel, glm.id);
      assert.equal(JSON.parse(storage.getItem("tinfoilModels")).fetchedAt, fetchedAt);
    }
  });
}

test("live refresh removes Flash and normalizes a selection restored after startup", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: markers,
    window: {
      electronAPI: { getTinfoilChatModels: async () => [other, flash, glm] },
    },
  });
  const vite = await createRendererServer(t);
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  settings.setStringSetting("cleanupProvider", "tinfoil");
  settings.setStringSetting("cleanupModel", flash.id);
  const models = await vite.ssrLoadModule("/models/tinfoilModels.ts");
  assert.deepEqual(
    (await models.refreshTinfoilModels()).map((m) => m.id),
    [other.id, glm.id]
  );
  assert.equal(settings.getSettings().cleanupModel, glm.id);
  const notice = await vite.ssrLoadModule("/stores/tinfoilModelSwitchStore.ts");
  assert.deepEqual(notice.consumeTinfoilModelSwitches(), [{ from: flash.name, to: glm.name }]);
});

for (const response of [null, [], [flash], "network-error"]) {
  test(`failed or unusable refresh (${JSON.stringify(response)}) retains supported cache and selection`, async (t) => {
    installBrowserGlobals(t, {
      initialStorage: {
        ...markers,
        tinfoilModels: JSON.stringify({ models: [other, flash], fetchedAt: 1 }),
        cleanupProvider: "tinfoil",
        cleanupModel: flash.id,
        cleanupMode: "providers",
      },
      window: {
        electronAPI: {
          getTinfoilChatModels: async () => {
            if (response === "network-error") throw new Error("offline");
            return response;
          },
        },
      },
    });
    const vite = await createRendererServer(t);
    const models = await vite.ssrLoadModule("/models/tinfoilModels.ts");
    const registry = await vite.ssrLoadModule("/models/ModelRegistry.ts");
    const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
    await assert.rejects(models.refreshTinfoilModels());
    assert.deepEqual(
      registry.getTinfoilModels().map((m) => m.id),
      [other.id, glm.id]
    );
    assert.equal(settings.getSettings().cleanupModel, glm.id);
  });
}

test("optional selections and custom endpoints survive, and failed migration writes retry", async () => {
  const { INFERENCE_SCOPES } = await import("../../src/config/inferenceScopes.ts");
  const { sweepRetiredCloudModelSelections } =
    await import("../../src/config/retiredCloudModels.ts");
  const scopes = Object.values(INFERENCE_SCOPES).map((s) => s.storeKeys);
  const data = new Map(
    Object.entries({
      ...markers,
      cleanupProvider: "custom",
      cleanupModel: flash.id,
      chatAgentProvider: "tinfoil",
      chatAgentModel: flash.id,
      dictationAgentVisionProvider: "tinfoil",
      dictationAgentVisionModel: "",
    })
  );
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: () => {
      throw Error("full");
    },
  };
  assert.deepEqual(sweepRetiredCloudModelSelections(storage, scopes), []);
  assert.equal(data.get("_retiredTinfoilModelsMigrated3"), undefined);
  storage.setItem = (key, value) => data.set(key, value);
  assert.equal(sweepRetiredCloudModelSelections(storage, scopes).length, 1);
  assert.equal(data.get("chatAgentModel"), glm.id);
  assert.equal(data.get("cleanupModel"), flash.id);
  assert.equal(data.get("dictationAgentVisionModel"), "");
});
