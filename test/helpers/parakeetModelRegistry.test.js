const test = require("node:test");
const assert = require("node:assert/strict");

const modelData = require("../../src/models/modelRegistryData.json");
const { BINARIES } = require("../../scripts/download-sherpa-onnx");

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
