const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/whisperPrewarmPolicy.js");

const base = {
  useLocalWhisper: true,
  localTranscriptionProvider: "whisper",
  whisperModel: "base",
};

test("prewarms when local whisper.cpp is the active provider with a model selected", async () => {
  const { shouldPrewarmLocalWhisper } = await load();
  assert.equal(shouldPrewarmLocalWhisper(base), true);
});

test("skips when local transcription is off (cloud/OpenWhispr-cloud dictation)", async () => {
  const { shouldPrewarmLocalWhisper } = await load();
  assert.equal(shouldPrewarmLocalWhisper({ ...base, useLocalWhisper: false }), false);
});

test("skips the NVIDIA Parakeet provider", async () => {
  const { shouldPrewarmLocalWhisper } = await load();
  assert.equal(shouldPrewarmLocalWhisper({ ...base, localTranscriptionProvider: "nvidia" }), false);
});

test("skips the Cohere (sherpa-onnx) provider", async () => {
  const { shouldPrewarmLocalWhisper } = await load();
  assert.equal(shouldPrewarmLocalWhisper({ ...base, localTranscriptionProvider: "cohere" }), false);
});

test("skips when no whisper model is selected yet", async () => {
  const { shouldPrewarmLocalWhisper } = await load();
  assert.equal(shouldPrewarmLocalWhisper({ ...base, whisperModel: "" }), false);
  assert.equal(shouldPrewarmLocalWhisper({ ...base, whisperModel: undefined }), false);
});

test("skips on missing/empty settings", async () => {
  const { shouldPrewarmLocalWhisper } = await load();
  assert.equal(shouldPrewarmLocalWhisper({}), false);
  assert.equal(shouldPrewarmLocalWhisper(undefined), false);
});
