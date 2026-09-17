const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The assistant panel used to answer on the Chat scope while the Voice Assistant
// scope sat unconfigured (mode defaulting to cloud, empty provider and model).
// Now that the panel answers on the Voice Assistant scope, a profile that never
// configured it must inherit its Chat scope once, or a signed-in Local/BYOK chat
// user would have spoken commands move to OpenWhispr Cloud silently.
test("the Voice Assistant scope is seeded from Chat once for profiles that never configured it", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-dictation-agent-seed-test-",
  });
  const load = async (seed) => {
    storage.clear();
    for (const [key, value] of Object.entries(seed)) storage.setItem(key, value);
    vite.moduleGraph.invalidateAll();
    const mod = await vite.ssrLoadModule("/stores/settingsStore.ts");
    return mod.useSettingsStore.getState();
  };
  const localChat = {
    _llmScopeKeysMigrated: "1",
    chatAgentMode: "local",
    chatAgentProvider: "llama",
    chatAgentModel: "qwen3-8b",
    chatAgentCloudMode: "byok",
  };

  await t.test("a Local chat with an untouched Voice Assistant scope copies it over", async () => {
    const state = await load(localChat);
    assert.equal(state.dictationAgentMode, "local");
    assert.equal(state.dictationAgentProvider, "llama");
    assert.equal(state.dictationAgentModel, "qwen3-8b");
    assert.equal(state.dictationAgentCloudMode, "byok");
    assert.equal(storage.getItem("_dictationAgentSeeded"), "key-pending");
  });

  await t.test("a self-hosted chat carries its endpoint", async () => {
    const state = await load({
      ...localChat,
      chatAgentMode: "self-hosted",
      chatAgentProvider: "custom",
      chatAgentRemoteUrl: "https://llm.lan:8080/v1",
    });
    assert.equal(state.dictationAgentMode, "self-hosted");
    assert.equal(state.dictationAgentRemoteUrl, "https://llm.lan:8080/v1");
  });

  await t.test("a Voice Assistant scope the user configured is left alone", async () => {
    const state = await load({ ...localChat, dictationAgentMode: "openwhispr" });
    assert.equal(state.dictationAgentMode, "openwhispr");
    assert.equal(state.dictationAgentProvider, "");
    assert.equal(storage.getItem("_dictationAgentSeeded"), "1");
  });

  await t.test("a scope with only a provider and model written counts as configured", async () => {
    const state = await load({
      ...localChat,
      dictationAgentProvider: "groq",
      dictationAgentModel: "openai/gpt-oss-20b",
    });
    assert.equal(state.dictationAgentMode, "openwhispr");
    assert.equal(state.dictationAgentProvider, "groq");
    assert.equal(state.dictationAgentModel, "openai/gpt-oss-20b");
  });

  // The provider-settings and agent-mode migrations leave a fresh profile's Chat
  // scope on the cloud default, so the copy is a no-op in effect.
  await t.test("a fresh profile inherits the same cloud default Chat was migrated to", async () => {
    const state = await load({});
    assert.equal(storage.getItem("chatAgentMode"), "openwhispr");
    assert.equal(state.dictationAgentMode, "openwhispr");
    assert.equal(state.dictationAgentProvider, "");
  });

  await t.test("a seeded profile is not seeded again after Chat changes", async () => {
    const state = await load({ ...localChat, _dictationAgentSeeded: "1" });
    assert.equal(state.dictationAgentMode, "openwhispr");
    assert.equal(storage.getItem("dictationAgentMode"), null);
  });
});
