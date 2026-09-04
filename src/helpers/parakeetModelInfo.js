const modelRegistryData = require("../models/modelRegistryData.json");

const TRANSDUCER_MODEL_FILES = [
  "encoder.int8.onnx",
  "decoder.int8.onnx",
  "joiner.int8.onnx",
  "tokens.txt",
];

const COHERE_TRANSCRIBE_MODEL_FILES = [
  "encoder.int8.onnx",
  "encoder.int8.onnx.data",
  "decoder.int8.onnx",
  "tokens.txt",
];

function getModelInfo(modelName) {
  return modelRegistryData.parakeetModels?.[modelName];
}

function getModelRuntime(modelName) {
  return getModelInfo(modelName)?.runtime === "online" ? "online" : "offline";
}

function getModelType(modelName) {
  return getModelInfo(modelName)?.modelType === "cohere-transcribe"
    ? "cohere-transcribe"
    : "transducer";
}

function getRequiredModelFiles(modelName) {
  return getModelType(modelName) === "cohere-transcribe"
    ? COHERE_TRANSCRIBE_MODEL_FILES
    : TRANSDUCER_MODEL_FILES;
}

// Both providers route to the parakeet/sherpa-onnx stack; only whisper differs.
function isSherpaLocalProvider(provider) {
  return provider === "nvidia" || provider === "cohere";
}

// Cohere Transcribe has no auto language detection — the WS server is started
// for exactly one language. Maps the app language (e.g. "auto", "zh-CN") to a
// supported code, falling back to English. Self-detecting models get null.
function resolveModelLanguage(modelName, language) {
  if (getModelType(modelName) !== "cohere-transcribe") return null;
  const base = typeof language === "string" ? language.split("-")[0].toLowerCase() : "";
  const supported = getModelInfo(modelName)?.supportedLanguages || [];
  return supported.includes(base) ? base : "en";
}

module.exports = {
  getModelRuntime,
  getModelType,
  getRequiredModelFiles,
  isSherpaLocalProvider,
  resolveModelLanguage,
};
