const modelRegistryData = require("../models/modelRegistryData.json");

const REQUIRED_MODEL_FILES = [
  "encoder.int8.onnx",
  "decoder.int8.onnx",
  "joiner.int8.onnx",
  "tokens.txt",
];

function getModelRuntime(modelName) {
  return modelRegistryData.parakeetModels?.[modelName]?.runtime === "online" ? "online" : "offline";
}

module.exports = { REQUIRED_MODEL_FILES, getModelRuntime };
