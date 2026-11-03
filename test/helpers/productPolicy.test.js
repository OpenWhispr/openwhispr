const test = require("node:test");
const assert = require("node:assert/strict");
const { defaultDevicePolicy } = require("../../src/helpers/managedDevicePolicy");
const { productOperationAllowed } = require("../../src/helpers/productPolicy");

test("main execution rejects cloud and BYOK inference while permitting independently allowed web search", () => {
  const policy = defaultDevicePolicy();
  policy.transcription.allowedModes = ["local"];
  policy.llm.allowedModes = ["local"];
  const snapshot = { success: true, managed: true, policy };
  for (const [channel, args] of [
    ["cloud-transcribe"],
    ["cloud-reason"],
    ["dictation-realtime-start", [{ mode: "byok", provider: "openai-realtime" }]],
    ["assemblyai-streaming-warmup", [{ mode: "byok" }]],
    ["corti-streaming-start", [{}]],
    ["process-anthropic-reasoning"],
    ["enterprise-stream-start", [{ provider: "bedrock" }]],
  ])
    assert.equal(productOperationAllowed(snapshot, "1.11.1", channel, args), false, channel);
  assert.equal(productOperationAllowed(snapshot, "1.11.1", "transcribe-local-whisper"), true);
  assert.equal(productOperationAllowed(snapshot, "1.11.1", "process-local-reasoning"), true);
  assert.equal(productOperationAllowed(snapshot, "1.11.1", "agent-web-search"), true);
  policy.features.webSearchEnabled = false;
  assert.equal(productOperationAllowed(snapshot, "1.11.1", "agent-web-search"), false);
});

test("direct operations enforce provider allowlists and the minimum app version", () => {
  const policy = defaultDevicePolicy();
  policy.transcription.allowedByokProviders = ["deepgram"];
  const snapshot = { success: true, managed: true, policy };
  assert.equal(
    productOperationAllowed(snapshot, "1.11.1", "deepgram-streaming-start", [{ mode: "byok" }]),
    true
  );
  assert.equal(
    productOperationAllowed(snapshot, "1.11.1", "assemblyai-streaming-start", [{ mode: "byok" }]),
    false
  );
  policy.minAppVersion = "1.12.0";
  for (const channel of ["acquire-recording-lock", "process-local-reasoning", "cloud-transcribe"])
    assert.equal(productOperationAllowed(snapshot, "1.11.1", channel), false);
  assert.equal(
    productOperationAllowed({ success: false }, "1.11.1", "process-local-reasoning"),
    false
  );
});
