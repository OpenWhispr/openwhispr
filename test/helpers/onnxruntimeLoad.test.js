const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getOnnxruntime,
  isOnnxruntimeAvailable,
  resetOnnxruntimeLoadCacheForTests,
} = require("../../src/helpers/onnxruntimeLoad.js");

test("getOnnxruntime probes once and exposes availability", () => {
  resetOnnxruntimeLoadCacheForTests();
  const ort = getOnnxruntime();
  assert.equal(isOnnxruntimeAvailable(), ort !== null);
  // Second call must reuse the cached probe result.
  assert.equal(getOnnxruntime(), ort);
});
