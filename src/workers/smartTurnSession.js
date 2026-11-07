// Pipecat Smart Turn v3 end-of-turn classifier on ONNX Runtime Web (WASM).
// WASM, not onnxruntime-node: the voice worker already holds sherpa-onnx's own
// ORT, and on Windows both ship a DLL named onnxruntime.dll, so a second native
// ORT in this process would depend on load order. WASM also covers Intel Macs,
// which onnxruntime-node >= 1.24 has no binding for.
const {
  prepareSmartTurnAudio,
  whisperLogMel,
  SMART_TURN_MELS,
  SMART_TURN_FRAMES,
} = require("../helpers/smartTurnFeatures");

async function createSmartTurnSession({ model, numThreads = 4 }) {
  const ort = require("onnxruntime-web");
  ort.env.wasm.numThreads = numThreads;
  const session = await ort.InferenceSession.create(model, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  /** Probability (0-1) that the speaker has finished, from up to the last 8 s of 16 kHz audio. */
  async function predict(samples) {
    const started = performance.now();
    const features = whisperLogMel(prepareSmartTurnAudio(samples));
    const featuresDone = performance.now();
    const outputs = await session.run({
      [inputName]: new ort.Tensor("float32", features, [1, SMART_TURN_MELS, SMART_TURN_FRAMES]),
    });
    const done = performance.now();
    return {
      probability: Number(outputs[outputName].data[0]),
      featureMs: featuresDone - started,
      inferenceMs: done - featuresDone,
    };
  }

  // The first WASM run compiles kernels (~2x a warm run); pay it at load time.
  await predict(new Float32Array(16000));
  return { predict };
}

module.exports = { createSmartTurnSession };
