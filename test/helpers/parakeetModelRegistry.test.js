const test = require("node:test");
const assert = require("node:assert/strict");

const modelData = require("../../src/models/modelRegistryData.json");
const { BINARIES } = require("../../scripts/download-sherpa-onnx");
const {
  getModelRuntime,
  getModelType,
  getRequiredModelFiles,
  isSherpaLocalProvider,
  resolveModelLanguage,
} = require("../../src/helpers/parakeetModelInfo");

test("Nemotron sherpa model uses the streaming runtime and bundled online server", () => {
  const model = modelData.parakeetModels["nemotron-speech-streaming-en-0.6b"];

  assert.equal(model.runtime, "online");
  assert.equal(
    model.extractDir,
    "sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25"
  );
  assert.match(
    model.downloadUrl,
    /sherpa-onnx-nemotron-speech-streaming-en-0\.6b-560ms-int8-2026-04-25\.tar\.bz2$/
  );
  assert.equal(model.language, "en");
  assert.deepEqual(model.supportedLanguages, ["en"]);

  for (const [platformArch, config] of Object.entries(BINARIES)) {
    assert.match(config.onlineBinaryPath, /sherpa-onnx-online-websocket-server/);
    assert.match(config.onlineOutputName, new RegExp(`^sherpa-onnx-online-ws-${platformArch}`));
  }
});

test("Nemotron 3.5 multilingual sherpa model uses the streaming runtime", () => {
  const model = modelData.parakeetModels["nemotron-3.5-asr-streaming-0.6b"];

  assert.equal(model.runtime, "online");
  assert.equal(
    model.extractDir,
    "sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11"
  );
  assert.match(
    model.downloadUrl,
    /sherpa-onnx-nemotron-3\.5-asr-streaming-0\.6b-560ms-int8-2026-06-11\.tar\.bz2$/
  );
  assert.equal(model.language, "multilingual");
  assert.ok(model.supportedLanguages.length >= 15);
  assert.ok(model.supportedLanguages.includes("en"));
  assert.ok(model.supportedLanguages.includes("ja"));
});

test("Cohere Transcribe registry entry is an offline cohere-transcribe model", () => {
  const model = modelData.parakeetModels["cohere-transcribe-03-2026"];

  assert.equal(model.modelType, "cohere-transcribe");
  assert.equal(model.runtime, undefined);
  assert.equal(model.language, "multilingual");
  assert.equal(model.supportedLanguages.length, 14);
  assert.match(
    model.downloadUrl,
    /sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01\.tar\.bz2$/
  );
  assert.equal(model.extractDir, "sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01");
});

test("model info helpers distinguish cohere-transcribe from transducer models", () => {
  assert.equal(getModelType("cohere-transcribe-03-2026"), "cohere-transcribe");
  assert.equal(getModelType("parakeet-tdt-0.6b-v3"), "transducer");
  assert.equal(getModelRuntime("cohere-transcribe-03-2026"), "offline");
  assert.deepEqual(getRequiredModelFiles("cohere-transcribe-03-2026"), [
    "encoder.int8.onnx",
    "encoder.int8.onnx.data",
    "decoder.int8.onnx",
    "tokens.txt",
  ]);
  assert.deepEqual(getRequiredModelFiles("parakeet-tdt-0.6b-v3"), [
    "encoder.int8.onnx",
    "decoder.int8.onnx",
    "joiner.int8.onnx",
    "tokens.txt",
  ]);
});

test("cohere language resolution maps app languages to supported codes", () => {
  assert.equal(resolveModelLanguage("cohere-transcribe-03-2026", "pl"), "pl");
  assert.equal(resolveModelLanguage("cohere-transcribe-03-2026", "zh-CN"), "zh");
  assert.equal(resolveModelLanguage("cohere-transcribe-03-2026", "auto"), "en");
  assert.equal(resolveModelLanguage("cohere-transcribe-03-2026", undefined), "en");
  assert.equal(resolveModelLanguage("parakeet-tdt-0.6b-v3", "pl"), null);
});

test("sherpa provider check covers nvidia and cohere only", () => {
  assert.ok(isSherpaLocalProvider("nvidia"));
  assert.ok(isSherpaLocalProvider("cohere"));
  assert.ok(!isSherpaLocalProvider("whisper"));
});
