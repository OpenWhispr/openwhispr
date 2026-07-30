const test = require("node:test");
const assert = require("node:assert/strict");
const WebSocket = require("ws");
const { WebSocketServer } = require("ws");

const OpenAIRealtimeStreaming = require("../../src/helpers/openaiRealtimeStreaming");

// Drives a real socket through the session handshake and hands back whatever
// the client sent before it considered itself connected.
async function captureSessionSetup(connectOptions) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `ws://127.0.0.1:${server.address().port}`;
  const received = [];

  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "session.created" }));
    socket.on("message", (data) => {
      received.push(JSON.parse(data.toString()));
      socket.send(JSON.stringify({ type: "session.updated" }));
    });
  });

  const streaming = new OpenAIRealtimeStreaming();
  try {
    await streaming.connect({
      apiKey: "test-key",
      createSocket: async () => new WebSocket(url),
      ...connectOptions,
    });
    // A preconfigured session never sends session.update, so there is nothing
    // to wait for; give a stray message one tick to show up before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    return received;
  } finally {
    streaming.cleanup();
    await new Promise((resolve) => server.close(resolve));
  }
}

const sessionUpdateInput = (messages) => {
  const update = messages.find((message) => message.type === "session.update");
  return update?.session?.audio?.input;
};

test("pins the requested language on a self-configured session", async () => {
  const messages = await captureSessionSetup({ language: "pl" });

  // Without this the session falls back to auto-detect, which drifts into
  // other languages on near-silent or bleed audio.
  assert.equal(sessionUpdateInput(messages).transcription.language, "pl");
});

test("omits language when the user selected auto-detect", async () => {
  const messages = await captureSessionSetup({ language: "auto" });

  assert.equal("language" in sessionUpdateInput(messages).transcription, false);
});

test("omits language when none was requested", async () => {
  const messages = await captureSessionSetup({});

  assert.equal("language" in sessionUpdateInput(messages).transcription, false);
});

test("declares the rate given as sampleRate, and lets inputRate win", async () => {
  // Meeting callers pass the rate as sampleRate, the name the other streaming
  // clients take; dictation passes inputRate.
  const bySampleRate = await captureSessionSetup({ sampleRate: 48000 });
  assert.equal(sessionUpdateInput(bySampleRate).format.rate, 48000);

  const byInputRate = await captureSessionSetup({ inputRate: 24000, sampleRate: 48000 });
  assert.equal(sessionUpdateInput(byInputRate).format.rate, 24000);
});

test("leaves a preconfigured session untouched", async () => {
  // The ephemeral token already carries language and noise reduction; a
  // session.update here would strip them.
  const messages = await captureSessionSetup({ language: "pl", preconfigured: true });

  assert.deepEqual(messages, []);
});
