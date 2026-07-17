const debugLogger = require("./debugLogger");

// Cached probe: undefined = not tried, null = failed, module = loaded.
let ortModule = undefined;
let loadError = null;

/**
 * Lazily require onnxruntime-node. Returns null when the native binding is
 * missing (e.g. darwin/x64 on onnxruntime-node >1.23) instead of throwing.
 */
function getOnnxruntime() {
  if (ortModule !== undefined) {
    return ortModule;
  }

  try {
    ortModule = require("onnxruntime-node");
    loadError = null;
  } catch (err) {
    ortModule = null;
    loadError = err;
    debugLogger.warn("onnxruntime-node unavailable", {
      error: err?.message || String(err),
    });
  }

  return ortModule;
}

function isOnnxruntimeAvailable() {
  return getOnnxruntime() !== null;
}

function getOnnxruntimeLoadError() {
  getOnnxruntime();
  return loadError;
}

function resetOnnxruntimeLoadCacheForTests() {
  ortModule = undefined;
  loadError = null;
}

module.exports = {
  getOnnxruntime,
  isOnnxruntimeAvailable,
  getOnnxruntimeLoadError,
  resetOnnxruntimeLoadCacheForTests,
};
