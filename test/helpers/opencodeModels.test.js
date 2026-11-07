const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const glm = {
  id: "glm-5.3",
  name: "GLM-5.3",
  description: "Flagship GLM model",
  supportsTemperature: true,
  tokenParam: "max_tokens",
};
const deepseek = {
  id: "deepseek-v4.1-flash",
  name: "DeepSeek V4.1 Flash",
  description: "",
  supportsTemperature: true,
  tokenParam: "max_tokens",
};
const kimiSeed = {
  id: "kimi-k2.7-code",
  name: "Kimi K2.7 Code",
  description: "",
  supportsTemperature: false,
  tokenParam: "max_tokens",
};
const markers = {
  _llmScopeKeysMigrated: "1",
  _retiredTinfoilModelsMigrated: "1",
  _retiredTinfoilModelsMigrated2: "1",
  _retiredTinfoilModelsMigrated3: "1",
};

test("a live list replaces the seed and moves a selection it dropped to the default", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      ...markers,
      cleanupProvider: "opencode-go",
      cleanupModel: kimiSeed.id,
      cleanupMode: "providers",
    },
    window: {
      electronAPI: { getOpencodeModels: async () => [deepseek, glm] },
    },
  });
  const vite = await createRendererServer(t);
  const { refreshOpencodeModels } = await vite.ssrLoadModule("/models/opencodeModels.ts");
  const registry = await vite.ssrLoadModule("/models/ModelRegistry.ts");
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");

  assert.deepEqual(
    (await refreshOpencodeModels("opencode-go")).map((m) => m.id),
    [deepseek.id, glm.id]
  );
  assert.deepEqual(
    registry.getOpencodeCatalogModels("opencode-go").map((m) => m.id),
    [deepseek.id, glm.id]
  );
  assert.equal(settings.getSettings().cleanupModel, glm.id);

  const notice = await vite.ssrLoadModule("/stores/retiredModelSwitchStore.ts");
  assert.deepEqual(notice.consumeRetiredModelSwitches(), [
    { provider: "opencode-go", from: kimiSeed.name, to: glm.name },
  ]);
});

test("a selection the live list still serves is left alone and announced nowhere", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      ...markers,
      cleanupProvider: "opencode-zen",
      cleanupModel: deepseek.id,
      cleanupMode: "providers",
    },
    window: {
      electronAPI: { getOpencodeModels: async () => [glm, deepseek] },
    },
  });
  const vite = await createRendererServer(t);
  const { refreshOpencodeModels } = await vite.ssrLoadModule("/models/opencodeModels.ts");
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const notice = await vite.ssrLoadModule("/stores/retiredModelSwitchStore.ts");

  await refreshOpencodeModels("opencode-zen");

  assert.equal(settings.getSettings().cleanupModel, deepseek.id);
  assert.deepEqual(notice.consumeRetiredModelSwitches(), []);
});

test("a fresh cache answers without a request and reaches the registry on load", async (t) => {
  let requests = 0;
  installBrowserGlobals(t, {
    initialStorage: {
      ...markers,
      "opencodeModels:opencode-zen": JSON.stringify({
        models: [deepseek],
        fetchedAt: Date.now() - 1000,
      }),
    },
    window: {
      electronAPI: {
        getOpencodeModels: async () => {
          requests += 1;
          return [glm];
        },
      },
    },
  });
  const vite = await createRendererServer(t);
  const { refreshOpencodeModels } = await vite.ssrLoadModule("/models/opencodeModels.ts");
  const registry = await vite.ssrLoadModule("/models/ModelRegistry.ts");

  assert.deepEqual(
    registry.getOpencodeCatalogModels("opencode-zen").map((m) => m.id),
    [deepseek.id]
  );
  assert.deepEqual(
    (await refreshOpencodeModels("opencode-zen")).map((m) => m.id),
    [deepseek.id]
  );
  assert.equal(requests, 0);
});

test("a cached id a later build retired is dropped on read", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      ...markers,
      "opencodeModels:opencode-go": JSON.stringify({
        models: [{ ...deepseek, id: "glm-5" }, glm],
        fetchedAt: Date.now() - 1000,
      }),
    },
  });
  const vite = await createRendererServer(t);
  const registry = await vite.ssrLoadModule("/models/ModelRegistry.ts");

  assert.deepEqual(
    registry.getOpencodeCatalogModels("opencode-go").map((m) => m.id),
    [glm.id]
  );
});

test("a cached entry without a display name is dropped on read", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      ...markers,
      "opencodeModels:opencode-go": JSON.stringify({
        models: [{ ...deepseek, name: "  " }, glm],
        fetchedAt: Date.now() - 1000,
      }),
    },
  });
  const vite = await createRendererServer(t);
  const registry = await vite.ssrLoadModule("/models/ModelRegistry.ts");

  assert.deepEqual(
    registry.getOpencodeCatalogModels("opencode-go").map((m) => m.id),
    [glm.id]
  );
});

test("a live entry without a display name still shows its id", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: { ...markers },
    window: {
      electronAPI: { getOpencodeModels: async () => [{ ...deepseek, name: "" }] },
    },
  });
  const vite = await createRendererServer(t);
  const { refreshOpencodeModels } = await vite.ssrLoadModule("/models/opencodeModels.ts");
  const registry = await vite.ssrLoadModule("/models/ModelRegistry.ts");

  await refreshOpencodeModels("opencode-go");

  assert.deepEqual(
    registry.REASONING_PROVIDERS["opencode-go"].models.map((m) => m.label),
    [deepseek.id]
  );
});

test("a failed refresh keeps the registry and the selection as they were", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      ...markers,
      cleanupProvider: "opencode-go",
      cleanupModel: kimiSeed.id,
      cleanupMode: "providers",
    },
    window: {
      electronAPI: {
        getOpencodeModels: async () => {
          throw new Error("offline");
        },
      },
    },
  });
  const vite = await createRendererServer(t);
  const { refreshOpencodeModels } = await vite.ssrLoadModule("/models/opencodeModels.ts");
  const registry = await vite.ssrLoadModule("/models/ModelRegistry.ts");
  const settings = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const before = registry.getOpencodeCatalogModels("opencode-go").map((m) => m.id);

  await assert.rejects(refreshOpencodeModels("opencode-go"), /offline/);

  assert.deepEqual(
    registry.getOpencodeCatalogModels("opencode-go").map((m) => m.id),
    before
  );
  assert.equal(settings.getSettings().cleanupModel, kimiSeed.id);
});

test("each product reads its own seed list before the first fetch", async (t) => {
  installBrowserGlobals(t, { initialStorage: markers });
  const vite = await createRendererServer(t);
  const registry = await vite.ssrLoadModule("/models/ModelRegistry.ts");

  assert.deepEqual(
    registry.getOpencodeCatalogModels("opencode-go").map((m) => m.id),
    ["glm-5.3", "deepseek-v4.1-flash", "kimi-k2.7-code", "minimax-m3.1-flash"]
  );
  assert.deepEqual(
    registry.getOpencodeCatalogModels("opencode-zen").map((m) => m.id),
    ["glm-5.3", "deepseek-v4.1-flash", "kimi-k3", "minimax-m3"]
  );
  assert.equal(registry.getOpencodeCatalogModel("opencode-go", "kimi-k3"), undefined);
});
