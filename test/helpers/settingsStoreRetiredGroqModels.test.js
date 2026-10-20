const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const modelRegistryData = require("../../src/models/modelRegistryData.json");

// Groq retired qwen3-32b and both Llamas on 2026-08-16, and shut down both
// Compound systems on 2026-09-21. The registry entries are gone, so a persisted
// scope selection would 404 on every request until the user re-picked — the
// migration remaps it to a model Groq still serves.
test("retired groq model selections migrate to served replacements", async (t) => {
  const groqIds = modelRegistryData.cloudProviders
    .find((provider) => provider.id === "groq")
    .models.map((model) => model.id);
  for (const retired of ["llama-3.3-70b-versatile", "groq/compound", "groq/compound-mini"]) {
    assert.ok(!groqIds.includes(retired), `retired id ${retired} must be out of the registry`);
  }

  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-retired-groq-models-test-",
  });

  const load = async () => {
    vite.moduleGraph.invalidateAll();
    return vite.ssrLoadModule("/stores/settingsStore.ts");
  };

  await t.test("groq scopes remap, other providers keep their model", async () => {
    storage.clear();
    storage.setItem("cleanupProvider", "groq");
    storage.setItem("cleanupModel", "llama-3.3-70b-versatile");
    storage.setItem("dictationAgentProvider", "groq");
    storage.setItem("dictationAgentModel", "llama-3.1-8b-instant");
    storage.setItem("chatAgentProvider", "openrouter");
    storage.setItem("chatAgentModel", "llama-3.3-70b-versatile");

    const { useSettingsStore } = await load();
    const state = useSettingsStore.getState();

    assert.equal(state.cleanupModel, "openai/gpt-oss-120b");
    assert.equal(state.dictationAgentModel, "openai/gpt-oss-20b");
    assert.equal(state.chatAgentModel, "llama-3.3-70b-versatile", "openrouter still serves the id");
  });

  await t.test("compound selections remap under the rotated sentinel", async () => {
    storage.clear();
    // Set by every build since the August sweep, so only the rotated key reaches these.
    storage.setItem("_retiredGroqModelsMigrated", "1");
    storage.setItem("cleanupProvider", "groq");
    storage.setItem("cleanupModel", "groq/compound");
    storage.setItem("dictationAgentProvider", "groq");
    storage.setItem("dictationAgentModel", "groq/compound-mini");

    const { useSettingsStore } = await load();
    const state = useSettingsStore.getState();

    assert.equal(state.cleanupModel, "openai/gpt-oss-120b");
    // The live reconcile would fall back to Groq's default (120b); 20b proves the sweep ran.
    assert.equal(state.dictationAgentModel, "openai/gpt-oss-20b");

    // The registry no longer names a retired id, so it is shown raw.
    const { consumeRetiredModelSwitches } = await vite.ssrLoadModule(
      "/stores/retiredModelSwitchStore.ts"
    );
    assert.deepEqual(consumeRetiredModelSwitches(), [
      { provider: "groq", from: "groq/compound", to: "GPT-OSS 120B" },
      { provider: "groq", from: "groq/compound-mini", to: "GPT-OSS 20B" },
    ]);
  });

  await t.test("migration is one-shot", async () => {
    storage.clear();
    storage.setItem("_retiredGroqModelsMigrated2", "1");
    storage.setItem("cleanupProvider", "groq");
    storage.setItem("cleanupModel", "llama-3.3-70b-versatile");

    const { useSettingsStore } = await load();
    assert.equal(useSettingsStore.getState().cleanupModel, "llama-3.3-70b-versatile");
  });
});
