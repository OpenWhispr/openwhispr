const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const WS = require("ws");

const load = () => import("../../src/helpers/openaiRealtimeStreaming.js");

function makeFakeSocket(readyState) {
  const socket = new EventEmitter();
  socket.readyState = readyState;
  socket.sent = [];
  socket.send = (data) => socket.sent.push(data);
  socket.ping = () => {};
  socket.terminate = () => {
    socket.readyState = WS.CLOSED;
    socket.emit("close", 1006, Buffer.from(""));
  };
  socket.close = () => {
    socket.readyState = WS.CLOSED;
  };
  return socket;
}

test("sendAudio buffers frames arriving before the socket exists (token-fetch window)", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();

  streaming.beginConnecting();
  assert.equal(streaming.ws, null, "socket not created yet, mirrors the token-fetch window");

  const sent = streaming.sendAudio(Buffer.from([1, 2, 3, 4]));

  assert.equal(sent, false);
  assert.equal(streaming.coldStartBuffer.length, 1);
  assert.equal(streaming.coldStartBufferSize, 4);
});

test("sendAudio drops frames when no connection attempt is in flight (idle/dead instance)", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();

  const sent = streaming.sendAudio(Buffer.from([1, 2, 3, 4]));

  assert.equal(sent, false);
  assert.equal(
    streaming.coldStartBuffer.length,
    0,
    "must not buffer forever with no connect in flight"
  );
});

test("sendAudio stops buffering once COLD_START_BUFFER_MAX is reached", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  streaming.beginConnecting();

  const chunk = Buffer.alloc(50000, 1);
  streaming.sendAudio(chunk); // size 0 -> 50000
  streaming.sendAudio(chunk); // size 50000 -> 100000
  streaming.sendAudio(chunk); // size 100000 -> 150000 (still under cap when checked)
  streaming.sendAudio(chunk); // size 150000, over the 144000 cap: dropped

  assert.equal(
    streaming.coldStartBuffer.length,
    3,
    "4th chunk must be dropped once the cap is exceeded"
  );
  assert.equal(streaming.coldStartBufferSize, 150000);
});

test("sendAudio flushes buffered audio in order once the socket opens, then sends the live chunk", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  streaming.beginConnecting();

  streaming.sendAudio(Buffer.from("first"));
  streaming.sendAudio(Buffer.from("second"));

  streaming.ws = makeFakeSocket(WS.OPEN);
  const sent = streaming.sendAudio(Buffer.from("third"));

  assert.equal(sent, true);
  assert.equal(streaming.ws.sent.length, 3);
  const payloads = streaming.ws.sent.map((raw) => JSON.parse(raw).audio);
  assert.deepEqual(payloads, [
    Buffer.from("first").toString("base64"),
    Buffer.from("second").toString("base64"),
    Buffer.from("third").toString("base64"),
  ]);
  assert.equal(streaming.coldStartBuffer.length, 0, "buffer must be cleared after flush");
});

test("connect() preserves audio buffered during beginConnecting() instead of wiping it", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();

  streaming.beginConnecting();
  streaming.sendAudio(Buffer.from("pre-token-fetch audio"));
  assert.equal(streaming.coldStartBuffer.length, 1);

  const socket = makeFakeSocket(WS.CONNECTING);
  const connected = streaming.connect({
    apiKey: "key",
    preconfigured: true,
    createSocket: async () => socket,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(streaming.coldStartBuffer.length, 1, "buffer must survive into connect()");

  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));
  await connected;

  streaming.sendAudio(Buffer.from("live"));
  const payloads = streaming.ws.sent.map((raw) => JSON.parse(raw).audio);
  assert.deepEqual(payloads, [
    Buffer.from("pre-token-fetch audio").toString("base64"),
    Buffer.from("live").toString("base64"),
  ]);
  streaming.cleanup();
});

test("sendAudio upsamples 16kHz capture to the 24kHz session rate", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  streaming.inputRate = 24000;
  streaming.captureRate = 16000;
  streaming.ws = makeFakeSocket(WS.OPEN);

  const pcm = new Int16Array([0, 100, 200, 300]);
  streaming.sendAudio(Buffer.from(pcm.buffer));

  const raw = Buffer.from(JSON.parse(streaming.ws.sent[0]).audio, "base64");
  const out = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
  assert.deepEqual([...out], [0, 67, 133, 200, 267, 300]);
  assert.equal(streaming.audioBytesSent, out.length * 2);
});

test("cleanup() resets bufferingAudio so a dead instance stops buffering", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  streaming.beginConnecting();

  streaming.cleanup();

  assert.equal(streaming.bufferingAudio, false);
  const sent = streaming.sendAudio(Buffer.from([1, 2, 3]));
  assert.equal(sent, false);
  assert.equal(streaming.coldStartBuffer.length, 0);
});

test("cleanup() stops the keep-alive interval", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  streaming.ws = makeFakeSocket(WS.OPEN);
  streaming.startKeepAlive();

  assert.notEqual(streaming.keepAliveInterval, null);
  streaming.cleanup();
  assert.equal(streaming.keepAliveInterval, null);
});

test("keep-alive terminates a connection that misses a pong", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  return (async () => {
    const OpenAIRealtimeStreaming = (await load()).default;
    const streaming = new OpenAIRealtimeStreaming();
    const socket = makeFakeSocket(WS.OPEN);
    let terminated = false;
    socket.terminate = () => {
      terminated = true;
      socket.readyState = WS.CLOSED;
    };
    streaming.ws = socket;

    streaming.startKeepAlive();

    t.mock.timers.tick(15000); // first tick: sends a ping, no pong arrives
    assert.equal(terminated, false);

    t.mock.timers.tick(15000); // second tick: no pong was received since the first ping
    assert.equal(terminated, true);
  })();
});

test("keep-alive stays alive when a pong is received between pings", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  return (async () => {
    const OpenAIRealtimeStreaming = (await load()).default;
    const streaming = new OpenAIRealtimeStreaming();
    const socket = makeFakeSocket(WS.OPEN);
    let terminated = false;
    socket.terminate = () => {
      terminated = true;
    };
    streaming.ws = socket;

    streaming.startKeepAlive();

    t.mock.timers.tick(15000);
    socket.emit("pong");
    t.mock.timers.tick(15000);

    assert.equal(terminated, false);
  })();
});
