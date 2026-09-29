const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/localModelSize.ts");

test("reads the parameter count from local model ids", async () => {
  const { estimateModelSizeB } = await load();
  const cases = {
    "qwen3.5-9b-q4_k_m": 9,
    "qwen3.5-4b-q4_k_m": 4,
    "qwen3-1.7b-q8_0": 1.7,
    "mistral-nemo-12b-instruct-q4_k_m": 12,
    "gpt-oss-20b-mxfp4": 20,
    "gemma-4-26b-a4b-it-q4_k_m": 26,
    "lfm2.5-8b-a1b-q4_k_m": 8,
    // Gemma 4's "effective" sizes: before this, E4B read as 0B and got no tools.
    "gemma-4-e4b-it-q4_k_m": 4,
    "gemma-4-e2b-it-qat-q4_0": 2,
    "lfm2.5-350m-q8_0": 0.35,
    "unknown-model": 0,
  };
  for (const [modelId, expected] of Object.entries(cases)) {
    assert.equal(estimateModelSizeB(modelId), expected, modelId);
  }
});
