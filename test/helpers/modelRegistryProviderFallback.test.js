const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const modelRegistryData = require("../../src/models/modelRegistryData.json");

// getModelProvider falls back to id heuristics for ids outside the registry
// (a GGUF the user renamed, a catalog entry not yet synced). Every local model
// family the catalog ships must resolve "local" there, or a non-registry id
// fails closed to "" and the dictation is dropped instead of routed.
test("non-registry ids of every local family fall back to the local provider", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: { _providerSettingsMigrated: "1", cleanupMode: "local" },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-model-provider-fallback-test-",
  });
  const { getModelProvider } = await vite.ssrLoadModule("/models/ModelRegistry.ts");

  const nonRegistryLocalIds = [
    "qwen3-4b-custom-finetune-q4_k_m",
    "llama-3.2-3b-custom-q4_k_m",
    "mistral-7b-custom-q4_k_m",
    "lfm2-1.2b-custom-q4_k_m",
    "gpt-oss-20b-mxfp4-custom",
    "gemma-4-e4b-custom-q4_0",
  ];
  for (const modelId of nonRegistryLocalIds) {
    assert.equal(getModelProvider(modelId), "local", modelId);
  }
});

test("gemma fallback does not capture gemini ids or registry cloud gemma models", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: { _providerSettingsMigrated: "1", cleanupMode: "local" },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-model-provider-fallback-test-",
  });
  const { getModelProvider } = await vite.ssrLoadModule("/models/ModelRegistry.ts");

  assert.equal(getModelProvider("gemini-9-ultra-preview"), "gemini");

  // Gemini and Tinfoil serve Gemma too; those ids are in the registry, so the
  // catalog lookup must keep winning over the local-family heuristic.
  const cloudGemmaIds = modelRegistryData.cloudProviders.flatMap((provider) =>
    provider.models.filter((model) => /gemma/i.test(model.id)).map((model) => model.id)
  );
  assert.ok(cloudGemmaIds.length > 0, "expected at least one cloud gemma id in the registry");
  for (const modelId of cloudGemmaIds) {
    assert.notEqual(getModelProvider(modelId), "local", modelId);
  }
});
