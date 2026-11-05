const test = require("node:test");
const assert = require("node:assert/strict");

const modelRegistryData = require("../../src/models/modelRegistryData.json");
const {
  QUALCOMM_MODEL_FILES,
  QUALCOMM_CHIPSETS,
  QUALCOMM_ASSET_TYPE,
  getModelInfo,
  getHfRepo,
  getHfModelSize,
  getRequiredModelFiles,
  isQualcommLocalProvider,
} = require("../../src/helpers/qualcommModelInfo");

test("Every qualcomm registry entry resolves its Hugging Face export repo and tokenizer repo", () => {
  for (const [modelId, info] of Object.entries(modelRegistryData.qualcommModels)) {
    assert.equal(getModelInfo(modelId), info);
    assert.match(getHfRepo(modelId), /^qualcomm\/Whisper-/);
    assert.match(getHfModelSize(modelId), /^(tiny|base|small|medium|large-v3-turbo)$/);
    assert.equal(getRequiredModelFiles(modelId), QUALCOMM_MODEL_FILES);
  }
});

test("Quantized variants map onto the plain tokenizer repos", () => {
  assert.equal(getHfModelSize("whisper-small-quantized"), "small");
  assert.equal(getHfModelSize("whisper-medium-quantized"), "medium");
  assert.equal(getHfModelSize("whisper-large-v3-turbo-quantized"), "large-v3-turbo");
});

test("Unknown model ids are rejected", () => {
  assert.equal(getModelInfo("ggml-base"), undefined);
  assert.equal(getHfRepo("ggml-base"), undefined);
  assert.equal(getHfModelSize("ggml-base"), undefined);
});

test("isQualcommLocalProvider matches only the qualcomm provider", () => {
  assert.equal(isQualcommLocalProvider("qualcomm"), true);
  assert.equal(isQualcommLocalProvider("whisper"), false);
  assert.equal(isQualcommLocalProvider("nvidia"), false);
  assert.equal(isQualcommLocalProvider("cohere"), false);
});

test("Resolve helper prefers Snapdragon X Elite chipsets and the precompiled QNN ONNX asset", () => {
  // resolveReleaseAssetUrl lives in qualcommWhisper (Electron-coupled); the
  // chipset preference order contract is what the sidecar download relies on.
  assert.deepEqual(QUALCOMM_CHIPSETS, [
    "qualcomm-snapdragon-x-elite",
    "qualcomm-snapdragon-x2-elite",
  ]);
  assert.equal(QUALCOMM_ASSET_TYPE, "precompiled_qnn_onnx");
});
