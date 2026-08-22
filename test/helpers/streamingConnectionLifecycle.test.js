const test = require("node:test");
const assert = require("node:assert/strict");

const AssemblyAiStreaming = require("../../src/helpers/assemblyAiStreaming");
const CortiStreaming = require("../../src/helpers/cortiStreaming");
const DeepgramStreaming = require("../../src/helpers/deepgramStreaming");
const OpenAIRealtimeStreaming = require("../../src/helpers/openaiRealtimeStreaming");

const clients = [
  ["OpenAI", OpenAIRealtimeStreaming, "_notifyConnectionLost"],
  ["AssemblyAI", AssemblyAiStreaming, "notifyConnectionLost"],
  ["Deepgram", DeepgramStreaming, "notifyConnectionLost"],
  ["Corti", CortiStreaming, "notifyConnectionLost"],
];

for (const [name, StreamingClient, notifyMethod] of clients) {
  test(`${name} reports one recoverable connection loss to meetings`, () => {
    const streaming = new StreamingClient();
    const recoveries = [];
    const errors = [];
    streaming.onConnectionLost = (error) => recoveries.push(error.message);
    streaming.onError = (error) => errors.push(error.message);

    streaming[notifyMethod](new Error("socket failed"));
    streaming[notifyMethod](new Error("duplicate close"));

    assert.deepEqual(recoveries, ["socket failed"]);
    assert.deepEqual(errors, []);
  });

  test(`${name} preserves the existing error path outside meetings`, () => {
    const streaming = new StreamingClient();
    const errors = [];
    streaming.onError = (error) => errors.push(error.message);

    streaming[notifyMethod](new Error("socket failed"));

    assert.deepEqual(errors, ["socket failed"]);
  });
}
