// The ONNX Runtime the voice worker's speech models run on. onnxruntime-node has no Intel Mac
// binding from 1.24 on, so those Macs run the same models on its WASM build, more slowly.
const WASM_THREADS = 4;

function loadVoiceOrt({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "darwin" && arch === "x64") {
    const ort = require("onnxruntime-web");
    ort.env.wasm.numThreads = WASM_THREADS;
    return {
      ort,
      sessionOptions: () => ({ executionProviders: ["wasm"], graphOptimizationLevel: "all" }),
    };
  }
  const ort = require("onnxruntime-node");
  return {
    ort,
    sessionOptions: (numThreads) => ({
      executionProviders: ["cpu"],
      executionMode: "sequential",
      graphOptimizationLevel: "all",
      interOpNumThreads: 1,
      intraOpNumThreads: numThreads,
    }),
  };
}

module.exports = { loadVoiceOrt };
