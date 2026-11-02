const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { GENERATE_NOTES_KEY } = require("../../src/helpers/builtinActions.js");

test("default summary preference persists, reloads and follows other windows without losing failed writes", async (t) => {
  const listeners = new Map();
  const { storage } = installBrowserGlobals(t, {
    initialStorage: { customDictionary: '["OpenWhispr"]' },
    window: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      electronAPI: { getOpenAIKey: async () => "", setDictionary: async () => {} },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-default-summary-setting-",
  });
  const reload = async () => {
    vite.moduleGraph.invalidateAll();
    const mod = await vite.ssrLoadModule("/stores/settingsStore.ts");
    await mod.initializeSettings();
    return mod.useSettingsStore;
  };
  let store = await reload();
  assert.equal(store.getState().defaultSummaryTemplateId, GENERATE_NOTES_KEY);
  store.getState().setDefaultSummaryTemplateId("custom-template");
  assert.equal(storage.getItem("defaultSummaryTemplateId"), "custom-template");
  store = await reload();
  assert.equal(store.getState().defaultSummaryTemplateId, "custom-template");
  listeners.get("storage")({
    key: "defaultSummaryTemplateId",
    newValue: "another-template",
    storageArea: storage,
  });
  assert.equal(store.getState().defaultSummaryTemplateId, "another-template");
  store.getState().setDefaultSummaryTemplateId(GENERATE_NOTES_KEY);
  assert.equal(storage.getItem("defaultSummaryTemplateId"), GENERATE_NOTES_KEY);
  storage.setItem = () => {
    throw new Error("Storage full");
  };
  assert.throws(
    () => store.getState().setDefaultSummaryTemplateId("custom-template"),
    /Storage full/
  );
  assert.equal(store.getState().defaultSummaryTemplateId, GENERATE_NOTES_KEY);
});
