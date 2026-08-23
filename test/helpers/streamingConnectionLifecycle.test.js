const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const WebSocket = require("ws");

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

for (const [name, StreamingClient] of clients) {
  test(`${name} non-finalizing disconnect overtakes a pending graceful close`, async () => {
    const streaming = new StreamingClient();
    const socket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      sent: [],
      send(payload) {
        this.sent.push(payload);
      },
      close() {
        this.readyState = WebSocket.CLOSED;
      },
    });
    streaming.ws = socket;
    streaming.isConnected = true;
    streaming.audioBytesSent = 3200;
    streaming.accumulatedText = "stale transcript";

    const gracefulClose = streaming.disconnect(true);
    await new Promise((resolve) => setImmediate(resolve));
    await streaming.disconnect(name === "OpenAI" ? { commit: false } : false);
    const outcome = await Promise.race([
      gracefulClose.then(
        () => "settled",
        () => "rejected"
      ),
      new Promise((resolve) => setImmediate(() => resolve("pending"))),
    ]);

    assert.equal(outcome, "settled");
    assert.equal(socket.readyState, WebSocket.CLOSED);
  });
}

test("Corti non-finalizing disconnect closes a warm-only transport", async (t) => {
  const streaming = new CortiStreaming();
  let closeCalls = 0;
  const warmSocket = {
    readyState: WebSocket.OPEN,
    close() {
      closeCalls += 1;
      this.readyState = WebSocket.CLOSED;
    },
  };
  streaming.warmConnection = warmSocket;
  streaming.warmConnectionReady = true;
  streaming.warmSessionId = "warm-session";
  streaming.keepAliveInterval = setInterval(() => {}, 60_000);
  t.after(() => streaming.cleanupWarmConnection());

  const result = await streaming.disconnect(false);

  assert.deepEqual(result, { text: "" });
  assert.equal(closeCalls, 1);
  assert.equal(streaming.warmConnection, null);
  assert.equal(streaming.keepAliveInterval, null);
  assert.equal(streaming.warmSessionId, null);
});
