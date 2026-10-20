const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const MODES = ["self-hosted", "local", "enterprise", "providers", "openwhispr"];
const CLOUD_MODES = new Set(["providers", "openwhispr"]);

test("cloud model reconciliation respects each scope's active mode", async (t) => {
  const { storage, window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-self-hosted-model-persistence-test-",
  });
  const { INFERENCE_SCOPES } = await vite.ssrLoadModule("/config/inferenceScopes.ts");
  // The optional vision override only supports cloud modes.
  const scopes = Object.values(INFERENCE_SCOPES).filter((scope) => !scope.optional);

  // Saves every scope in `mode` with a model `provider` no longer serves, then
  // reloads the settings store, as a new renderer does on app restart.
  async function restartWith({ mode, provider, model, skipStartupMigration }) {
    storage.clear();
    storage.setItem("_llmScopeKeysMigrated", "1");
    if (skipStartupMigration) {
      storage.setItem("_retiredGroqModelsMigrated2", "1");
      storage.setItem("_retiredTinfoilModelsMigrated2", "1");
    }
    for (const { storeKeys } of scopes) {
      storage.setItem(storeKeys.mode, mode);
      storage.setItem(storeKeys.provider, provider);
      storage.setItem(storeKeys.model, model);
    }
    vite.moduleGraph.invalidateAll();
    return vite.ssrLoadModule("/stores/settingsStore.ts");
  }

  function assertModels(useSettingsStore, expected) {
    for (const { storeKeys } of scopes) {
      assert.equal(useSettingsStore.getState()[storeKeys.model], expected, storeKeys.model);
      assert.equal(storage.getItem(storeKeys.model), expected, `${storeKeys.model} in storage`);
    }
  }

  async function tinfoilNoticeCount() {
    const { consumeRetiredModelSwitches } = await vite.ssrLoadModule(
      "/stores/retiredModelSwitchStore.ts"
    );
    return consumeRetiredModelSwitches().length;
  }

  for (const mode of MODES) {
    const cloud = CLOUD_MODES.has(mode);

    await t.test(`startup migration in ${mode} mode`, async () => {
      const { useSettingsStore } = await restartWith({
        mode,
        provider: "tinfoil",
        model: "glm-5-2",
      });
      assertModels(useSettingsStore, cloud ? "glm-5-3" : "glm-5-2");
      assert.equal(await tinfoilNoticeCount(), cloud ? 1 : 0);
    });

    await t.test(`startup reconciliation in ${mode} mode`, async () => {
      const { useSettingsStore, reconcileRetiredCloudModelSelections } = await restartWith({
        mode,
        provider: "groq",
        model: "my-hosted-model",
        skipStartupMigration: true,
      });
      reconcileRetiredCloudModelSelections();
      assertModels(useSettingsStore, cloud ? "openai/gpt-oss-120b" : "my-hosted-model");
      assert.equal(await tinfoilNoticeCount(), 0);
    });

    await t.test(`live Tinfoil catalog in ${mode} mode`, async () => {
      const { useSettingsStore } = await restartWith({
        mode,
        provider: "tinfoil",
        model: "glm-5-2",
        skipStartupMigration: true,
      });
      window.electronAPI.getTinfoilChatModels = async () => [
        { id: "glm-5-3", name: "GLM-5.3", description: "", supportsThinking: true },
      ];
      const { refreshTinfoilModels } = await vite.ssrLoadModule("/models/tinfoilModels.ts");
      await refreshTinfoilModels();
      assertModels(useSettingsStore, cloud ? "glm-5-3" : "glm-5-2");
      assert.equal(await tinfoilNoticeCount(), cloud ? 1 : 0);
    });
  }
});

// The reported path: Chat's provider key was never written, so it loads as the
// default Groq, and the app's own startup runs the repairs (#2789).
test("a Self-Hosted Chat model survives the app's startup with the default provider", async (t) => {
  const { storage } = installBrowserGlobals(t, {
    window: { electronAPI: { getOpenAIKey: async () => "", setDictionary: async () => {} } },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-self-hosted-model-startup-test-",
  });

  for (const [mode, expected] of [
    ["self-hosted", "my-hosted-model"],
    ["providers", "openai/gpt-oss-120b"],
  ]) {
    storage.clear();
    storage.setItem("_llmScopeKeysMigrated", "1");
    // Already holds the agent name, so startup starts no cloud dictionary sync.
    storage.setItem("customDictionary", '["OpenWhispr"]');
    storage.setItem("chatAgentMode", mode);
    storage.setItem("chatAgentModel", "my-hosted-model");
    vite.moduleGraph.invalidateAll();
    const { initializeSettings, useSettingsStore } = await vite.ssrLoadModule(
      "/stores/settingsStore.ts"
    );
    try {
      await initializeSettings();
    } finally {
      const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
      await i18n.changeLanguage("en");
    }

    const state = useSettingsStore.getState();
    assert.equal(state.chatAgentProvider, "groq", mode);
    assert.equal(state.chatAgentModel, expected, mode);
    assert.equal(storage.getItem("chatAgentModel"), expected, `${mode} in storage`);
  }
});

test("switching modes clears a model the new mode's provider doesn't serve", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-mode-switch-patch-test-",
  });
  const { modeSwitchPatch } = await vite.ssrLoadModule("/utils/llmModeSwitch.ts");
  const selfHostedUnderGroq = { provider: "groq", model: "my-hosted-model" };

  assert.deepEqual(modeSwitchPatch(selfHostedUnderGroq, "providers"), {
    mode: "providers",
    cloudMode: "byok",
    model: "",
  });
  assert.deepEqual(
    modeSwitchPatch({ provider: "groq", model: "openai/gpt-oss-120b" }, "providers"),
    { mode: "providers", cloudMode: "byok" }
  );
  assert.deepEqual(modeSwitchPatch({ provider: "custom", model: "my-hosted-model" }, "providers"), {
    mode: "providers",
    cloudMode: "byok",
  });
  assert.deepEqual(modeSwitchPatch(selfHostedUnderGroq, "openwhispr"), {
    mode: "openwhispr",
    cloudMode: "openwhispr",
  });
  assert.deepEqual(modeSwitchPatch(selfHostedUnderGroq, "local"), {
    mode: "local",
    cloudMode: "byok",
    provider: "",
    model: "",
  });
  assert.deepEqual(
    modeSwitchPatch({ provider: "groq", model: "openai/gpt-oss-120b" }, "self-hosted"),
    { mode: "self-hosted", cloudMode: "byok" }
  );
});
