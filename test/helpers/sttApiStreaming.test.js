const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");

const { WebSocketServer } = require("ws");

const SttApiStreaming = require("../../src/helpers/sttApiStreaming");

// Mock stt-api stream endpoint implementing the Phase 5 wire contract: bearer
// header, optional `stt-segments` subprotocol, binary PCM16LE in, JSON frames out.
async function startMockServer({ selectSegmentsProtocol = true, onConnection } = {}) {
  const seen = { authorization: null, protocol: null, frames: [], messages: [] };
  const wss = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    handleProtocols: (protocols) =>
      selectSegmentsProtocol && protocols.has("stt-segments") ? "stt-segments" : false,
  });
  await once(wss, "listening");
  wss.on("connection", (socket, request) => {
    seen.authorization = request.headers.authorization;
    seen.protocol = socket.protocol;
    seen.request = request;
    socket.on("message", (data, isBinary) => {
      if (isBinary) seen.frames.push(Buffer.from(data));
      else seen.messages.push(data.toString());
    });
    onConnection?.(socket, seen);
  });
  return {
    seen,
    baseUrl: `http://127.0.0.1:${wss.address().port}/v1`,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

const send = (socket, frame) => socket.send(JSON.stringify(frame));
const pcm24k = (samples) => Buffer.alloc(samples * 2, 1);
const until = async (predicate, label) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("meeting mode: bearer header, stt-segments subprotocol, 16 kHz frames, ordered segment callbacks", async () => {
  const server = await startMockServer();
  const client = new SttApiStreaming();
  const partials = [];
  const finals = [];
  client.onPartialTranscript = (text) => partials.push(text);
  client.onFinalTranscript = (text) => finals.push(text);

  try {
    await client.connect({
      baseUrl: server.baseUrl,
      token: "license-key",
      sampleRate: 24000,
    });
    assert.equal(client.isConnected, true);
    assert.equal(server.seen.authorization, "Bearer license-key");
    assert.equal(server.seen.protocol, "stt-segments");
    // The key travels in the header only, never in the request URL.
    assert.ok(!server.seen.request.url.includes("license-key"));
    assert.equal(server.seen.request.url.includes("?"), false);

    // 24 kHz input (2400 samples, 100 ms) must arrive as 16 kHz even-length frames.
    assert.equal(client.sendAudio(pcm24k(2400)), true);
    assert.equal(client.sendAudio(pcm24k(2401)), true);
    await until(() => server.seen.frames.length >= 2, "audio frames");
    for (const frame of server.seen.frames) assert.equal(frame.length % 2, 0);
    const samples = server.seen.frames.reduce((sum, frame) => sum + frame.length / 2, 0);
    assert.ok(Math.abs(samples - 3200) <= 3, `expected about 3200 samples, got ${samples}`);
  } finally {
    await client.disconnect(false);
    await server.close();
  }

  // Segment frames in order: open segment updates, then it closes; cumulative
  // `partial` frames are ignored in segments mode.
  const ordered = await startMockServer({
    onConnection: (socket) => {
      send(socket, { type: "partial", text: "ignored cumulative" });
      send(socket, { type: "segment", index: 0, text: "hel", final: false });
      send(socket, { type: "segment", index: 0, text: "hello there", final: true });
      send(socket, { type: "segment", index: 1, text: "second", final: false });
      send(socket, { type: "segment", index: 1, text: "second one", final: true });
    },
  });
  const reader = new SttApiStreaming();
  const readerPartials = [];
  const readerFinals = [];
  reader.onPartialTranscript = (text) => readerPartials.push(text);
  reader.onFinalTranscript = (text) => readerFinals.push(text);
  try {
    await reader.connect({ baseUrl: ordered.baseUrl, token: "k", sampleRate: 24000 });
    await until(() => readerFinals.length === 2, "two final segments");
    assert.deepEqual(readerPartials, ["hel", "second"]);
    assert.deepEqual(readerFinals, ["hello there", "hello there second one"]);
    assert.deepEqual(reader.completedSegments, ["hello there", "second one"]);
  } finally {
    await reader.disconnect(false);
    await ordered.close();
  }
});

test("finalize sends finish and resolves on the closing final frame without re-emitting it", async () => {
  const server = await startMockServer({
    onConnection: (socket) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary || data.toString() !== '{"type":"finish"}') return;
        send(socket, { type: "segment", index: 0, text: "tail words", final: true });
        send(socket, { type: "final", text: "tail words", truncated: false });
      });
    },
  });
  const client = new SttApiStreaming();
  const finals = [];
  client.onFinalTranscript = (text) => finals.push(text);

  try {
    await client.connect({ baseUrl: server.baseUrl, token: "k", sampleRate: 24000 });
    const result = await client.disconnect();
    assert.deepEqual(server.seen.messages, ['{"type":"finish"}']);
    assert.equal(result.text, "tail words");
    // The closing final frame carries the cumulative text; it is not a new segment.
    assert.deepEqual(finals, ["tail words"]);
  } finally {
    await server.close();
  }
});

test("a segment the server never closed is committed once at the closing final frame", async () => {
  const server = await startMockServer({
    onConnection: (socket) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        send(socket, { type: "segment", index: 4, text: "dangling words", final: false });
        send(socket, { type: "final", text: "dangling words", truncated: false });
      });
    },
  });
  const client = new SttApiStreaming();
  const finals = [];
  client.onFinalTranscript = (text) => finals.push(text);

  try {
    await client.connect({ baseUrl: server.baseUrl, token: "k", sampleRate: 24000 });
    await client.disconnect();
    assert.deepEqual(finals, ["dangling words"]);
  } finally {
    await server.close();
  }
});

test("connect fails when the server does not select stt-segments", async () => {
  const server = await startMockServer({ selectSegmentsProtocol: false });
  const client = new SttApiStreaming();

  try {
    await assert.rejects(
      client.connect({ baseUrl: server.baseUrl, token: "k", sampleRate: 24000 }),
      /subprotocol/i
    );
    assert.equal(client.isConnected, false);
  } finally {
    await server.close();
  }
});

test("connect refuses a missing key and a cleartext non-loopback endpoint without opening a socket", async () => {
  const client = new SttApiStreaming();

  await assert.rejects(client.connect({ baseUrl: "https://stt.example.test/v1" }), /sign-in/i);
  await assert.rejects(
    client.connect({ baseUrl: "http://stt.example.test/v1", token: "k" }),
    /non-TLS/
  );
});

test("an unexpected close during the session reports the connection as lost", async () => {
  const server = await startMockServer({
    onConnection: (socket) => setTimeout(() => socket.terminate(), 30),
  });
  const client = new SttApiStreaming();
  let lost = null;
  client.onConnectionLost = (error) => {
    lost = error;
  };

  try {
    await client.connect({ baseUrl: server.baseUrl, token: "k", sampleRate: 24000 });
    await until(() => lost !== null, "connection lost");
    assert.match(lost.message, /Connection lost/);
    assert.equal(client.isConnected, false);
  } finally {
    await server.close();
  }
});

test("an error frame reaches onError", async () => {
  const server = await startMockServer({
    onConnection: (socket) =>
      send(socket, { type: "error", error: { code: "busy", message: "stream pool is full" } }),
  });
  const client = new SttApiStreaming();
  let error = null;
  client.onError = (e) => {
    error = e;
  };

  try {
    await client.connect({ baseUrl: server.baseUrl, token: "k", sampleRate: 24000 });
    await until(() => error !== null, "error frame");
    assert.equal(error.message, "stream pool is full");
    assert.equal(error.code, "busy");
  } finally {
    await client.disconnect(false);
    await server.close();
  }
});

test("preview mode: no subprotocol, cumulative partial frames reach onPartialTranscript", async () => {
  const server = await startMockServer({
    onConnection: (socket) => {
      send(socket, { type: "partial", text: "hello" });
      send(socket, { type: "partial", text: "hello wor" });
      send(socket, { type: "partial", text: "hello world" });
    },
  });
  const client = new SttApiStreaming();
  const partials = [];
  client.onPartialTranscript = (text) => partials.push(text);

  try {
    // Already 16 kHz: frames are forwarded untouched.
    await client.connect({
      baseUrl: server.baseUrl,
      token: "k",
      segments: false,
      sampleRate: 16000,
    });
    assert.equal(server.seen.protocol, "");
    assert.equal(server.seen.authorization, "Bearer k");
    await until(() => partials.length === 3, "partial frames");
    assert.deepEqual(partials, ["hello", "hello wor", "hello world"]);

    const frame = Buffer.alloc(3200, 2);
    client.sendAudio(frame);
    await until(() => server.seen.frames.length === 1, "preview audio frame");
    assert.equal(server.seen.frames[0].length, 3200);
  } finally {
    await client.disconnect(false);
    await server.close();
  }
});

test("a 404 'streaming is not configured' refusal is an error and is not retried", async () => {
  let attempts = 0;
  const server = http.createServer();
  server.on("upgrade", (request, socket) => {
    attempts += 1;
    socket.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const client = new SttApiStreaming();
  try {
    await assert.rejects(
      client.connect({
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        token: "k",
        segments: false,
        sampleRate: 16000,
      }),
      /404/
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(attempts, 1);
    assert.equal(client.isConnected, false);
  } finally {
    server.close();
  }
});

test("preview adapter: partials reach onUpdate, finish returns the final text and never claims a commit", async () => {
  const server = await startMockServer({
    onConnection: (socket) => {
      send(socket, { type: "partial", text: "good morning" });
      socket.on("message", (data, isBinary) => {
        if (isBinary || data.toString() !== '{"type":"finish"}') return;
        send(socket, { type: "final", text: "good morning everyone", truncated: false });
      });
    },
  });
  const { createSttApiPreviewStream } = SttApiStreaming;
  const updates = [];

  try {
    const stream = await createSttApiPreviewStream({
      baseUrl: server.baseUrl,
      key: "k",
      onUpdate: (text) => updates.push(text),
      onError: () => {},
    });
    assert.equal(server.seen.protocol, "");
    await until(() => updates.length === 1, "preview partial");
    assert.deepEqual(updates, ["good morning"]);

    stream.sendPcm16(Buffer.alloc(3200, 3));
    const result = await stream.finish();
    assert.deepEqual(result, { text: "good morning everyone", truncated: false });
    assert.equal(server.seen.frames.length, 1);
  } finally {
    await server.close();
  }
});

test("cancelling while the handshake is in flight rejects the connect and arms no keep-alive", async () => {
  const server = await startMockServer();
  const client = new SttApiStreaming();

  try {
    const pending = client.connect({ baseUrl: server.baseUrl, token: "k", sampleRate: 24000 });
    client.cleanup();
    await assert.rejects(pending);
    assert.equal(client.keepAliveInterval, null);
    assert.equal(client.isConnected, false);
  } finally {
    await server.close();
  }
});

test("the silence keep-alive runs while warm and stops for good after cleanup", async () => {
  const server = await startMockServer();
  const client = new SttApiStreaming();
  client.keepAliveMs = 20;

  try {
    await client.connect({ baseUrl: server.baseUrl, token: "k", sampleRate: 24000 });
    await until(() => server.seen.frames.length >= 2, "keep-alive silence frames");
    client.cleanup();
    assert.equal(client.keepAliveInterval, null);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = server.seen.frames.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(server.seen.frames.length, after, "no frames after cleanup");
  } finally {
    await server.close();
  }
});
