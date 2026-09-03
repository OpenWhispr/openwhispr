const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const modelRegistryData = require("../../src/models/modelRegistryData.json");

// Tinfoil retires GLM-5.2 on 2026-09-10 (replaced by glm-5-3) and its live
// /v1/models list already omits it. The default lookup must follow, otherwise
// every reconciled selection lands on whatever Tinfoil happens to list first.
const LIVE_CATALOG = [
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", description: "", supportsThinking: true },
  { id: "glm-5-3", name: "GLM-5.3", description: "", supportsThinking: true },
  { id: "gpt-oss-120b", name: "GPT-OSS 120B", description: "", supportsThinking: true },
];

test("tinfoil default model follows the glm-5-3 replacement", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-tinfoil-default-model-test-",
  });
  const { pickDefaultTinfoilModel } = await vite.ssrLoadModule("/models/tinfoilModels.ts");

  await t.test("picks glm-5-3 even when Tinfoil lists another model first", () => {
    assert.equal(pickDefaultTinfoilModel(LIVE_CATALOG)?.id, "glm-5-3");
  });

  await t.test("still falls back to the first served model when the default is gone", () => {
    assert.equal(pickDefaultTinfoilModel(LIVE_CATALOG.slice(0, 1))?.id, "deepseek-v4-flash");
  });

  await t.test("seeded registry leads with the default and no longer ships glm-5-2", () => {
    const tinfoil = modelRegistryData.cloudProviders.find((provider) => provider.id === "tinfoil");
    const ids = tinfoil.models.map((model) => model.id);
    assert.equal(ids[0], "glm-5-3");
    assert.ok(!ids.includes("glm-5-2"), "retired id must be out of the seed");
  });
});
