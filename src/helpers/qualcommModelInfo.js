const modelRegistryData = require("../models/modelRegistryData.json");

// Files every Qualcomm NPU export must contain. encoder/decoder .onnx are
// EPContext wrappers; the .bin siblings hold the precompiled QNN context.
// tokenizer/config files come from openai/whisper-<size> and drive the
// feature extractor and decode loop offline.
const QUALCOMM_MODEL_FILES = [
  "encoder.onnx",
  "encoder.bin",
  "decoder.onnx",
  "decoder.bin",
  "metadata.json",
  "config.json",
  "preprocessor_config.json",
  "tokenizer_config.json",
  "vocab.json",
  "merges.txt",
];

// Chipsets the models are exported for, in preference order. release_assets.json
// keys them "qualcomm-snapdragon-x-elite" / "qualcomm-snapdragon-x2-elite".
const QUALCOMM_CHIPSETS = ["qualcomm-snapdragon-x-elite", "qualcomm-snapdragon-x2-elite"];

// Asset format: ONNX wrappers around precompiled QNN context binaries, run via
// the ONNX Runtime QNN execution provider (see resources/qualcomm/whisper_npu_sidecar.py).
const QUALCOMM_ASSET_TYPE = "precompiled_qnn_onnx";

function getModelInfo(modelName) {
  return modelRegistryData.qualcommModels?.[modelName];
}

function getHfRepo(modelName) {
  return getModelInfo(modelName)?.hfRepo;
}

function getHfModelSize(modelName) {
  return getModelInfo(modelName)?.hfModelSize;
}

function getRequiredModelFiles(modelName) {
  return QUALCOMM_MODEL_FILES;
}

function isQualcommLocalProvider(provider) {
  return provider === "qualcomm";
}

module.exports = {
  QUALCOMM_MODEL_FILES,
  QUALCOMM_CHIPSETS,
  QUALCOMM_ASSET_TYPE,
  getModelInfo,
  getHfRepo,
  getHfModelSize,
  getRequiredModelFiles,
  isQualcommLocalProvider,
};
