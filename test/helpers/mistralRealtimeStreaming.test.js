const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { WebSocket, WebSocketServer } = require("ws");
const Streaming = require("../../src/helpers/mistralRealtimeStreaming");
const debugLogger = require("../../src/helpers/debugLogger");
const { i18nMain, changeLanguage } = require("../../src/helpers/i18nMain");

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  terminate() {
    this.close();
  }
  event(value) {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }
}

async function connected(options = {}) {
  const socket = new Socket();
  let request;
  const client = new Streaming((url, config) => {
    request = { url, config };
    return socket;
  });
  const pending = client.connect({ apiKey: "test-secret", sampleRate: 24000, ...options });
  socket.event({ type: "session.created" });
  assert.equal(client.isConnected, false, "capture must wait for configured session");
  socket.event({
    type: "session.updated",
    session: { audio_format: { encoding: "pcm_s16le", sample_rate: 24000 } },
  });
  await pending;
  return { client, socket, request };
}

test("Mistral errors follow the current UI language and keep credentials private", async (t) => {
  const previousLanguage = i18nMain.language;
  t.after(() => changeLanguage(previousLanguage));
  changeLanguage("fr");

  const socket = new Socket();
  const client = new Streaming(() => socket);
  const pending = client.connect({ apiKey: "private-key" });
  socket.emit("error", new Error("Unexpected server response: 401 private-key"));
  await assert.rejects(pending, { message: "Mistral a rejeté votre clé API." });
  await assert.rejects(client.connect(), /Aucune clé API/);

  const active = await connected();
  const errors = [];
  active.client.onError = (error) => errors.push(error.message);
  const stop = active.client.disconnect();
  active.socket.emit("close", 1006);
  await stop;
  assert.match(errors[0], /les derniers mots peuvent manquer/);
});

test("lifecycle logs identify each stream without audio, transcripts, or credentials", async (t) => {
  const logs = [];
  for (const level of ["debug", "warn"]) {
    t.mock.method(debugLogger, level, (message, context) => logs.push({ level, message, context }));
  }
  const { client, socket } = await connected({ streamLabel: "system" });
  socket.event({ type: "transcription.text.delta", text: "confidential meeting phrase" });
  const stop = client.disconnect();
  socket.event({ type: "transcription.done", text: "confidential meeting phrase" });
  await stop;
  assert.ok(
    logs.some(
      (entry) => entry.message === "Mistral realtime connected" && entry.context.stream === "system"
    )
  );
  assert.ok(
    logs.some(
      (entry) => entry.message === "Mistral realtime finalized" && entry.context.stream === "system"
    )
  );

  const mic = await connected({ streamLabel: "mic" });
  mic.socket.emit("error", new Error("Unexpected server response: 401 test-secret"));
  assert.ok(logs.some((entry) => entry.level === "warn" && entry.context.stream === "mic"));
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes("test-secret"));
  assert.ok(!serialized.includes("confidential meeting phrase"));
  assert.ok(!serialized.includes("Authorization"));
});

test("Bearer authentication, explicit PCM format and normalized language use Mistral protocol", async () => {
  const { client, socket, request } = await connected({ language: "fr-FR" });
  assert.equal(request.config.headers.Authorization, "Bearer test-secret");
  assert.equal(
    new URL(request.url).searchParams.get("model"),
    "voxtral-mini-transcribe-realtime-3"
  );
  assert.ok(!request.url.includes("test-secret"));
  assert.deepEqual(socket.sent[0], {
    type: "session.update",
    session: {
      audio_format: { encoding: "pcm_s16le", sample_rate: 24000 },
      target_streaming_delay_ms: 480,
      language: "fr",
    },
  });
  assert.equal(client.sendAudio(Buffer.from([0, 1, 2, 3])), true);
  assert.deepEqual(socket.sent[1], { type: "input_audio.append", audio: "AAECAw==" });
  client.cleanup();
});

test("auto language sends no pin", async () => {
  const { client, socket } = await connected({ language: "auto" });
  assert.equal(Object.hasOwn(socket.sent[0].session, "language"), false);
  client.cleanup();
});

test("append-only deltas preserve spaces, emit live segments and finalize last words once", async () => {
  const { client, socket } = await connected();
  const finals = [];
  const partials = [];
  client.onFinalTranscript = () => finals.push(client.completedSegments.at(-1));
  client.onPartialTranscript = (text) => partials.push(text);
  for (const text of ["Bonjour", " à tous", ".", " Derniers"])
    socket.event({ type: "transcription.text.delta", text });
  assert.deepEqual(finals, ["Bonjour à tous."]);
  assert.equal(partials.at(-1), "Derniers");
  const stop = client.disconnect();
  assert.equal(socket.sent.at(-1).type, "input_audio.end");
  assert.equal(client.sendAudio(Buffer.alloc(2)), false);
  socket.event({ type: "transcription.text.delta", text: " mots" });
  socket.event({ type: "transcription.done", text: "Bonjour à tous. Derniers mots." });
  socket.event({ type: "transcription.done", text: "Bonjour à tous. Derniers mots." });
  assert.deepEqual(await stop, { text: "Bonjour à tous. Derniers mots." });
  assert.deepEqual(finals, ["Bonjour à tous.", "Derniers mots."]);
  assert.equal(client.isConnected, false);
});

test("long speech commits at word boundaries before the session ends", async () => {
  const { client, socket } = await connected();
  socket.event({ type: "transcription.text.delta", text: "réunion ".repeat(30) });
  assert.ok(client.completedSegments.length > 0);
  assert.equal(client.getFullTranscript(), "réunion ".repeat(30).trim());
  client.cleanup();
});

test("speech without spaces is committed before stop, including CJK sentence boundaries", async () => {
  const { client, socket } = await connected();
  socket.event({ type: "transcription.text.delta", text: "你好。世界" });
  assert.deepEqual(client.completedSegments, ["你好。"]);
  const longPhrase = "会議".repeat(100);
  socket.event({ type: "transcription.text.delta", text: longPhrase });
  assert.deepEqual(client.completedSegments, ["你好。", `世界${longPhrase}`]);
  client.cleanup();
});

test("disconnect waits for done even when no audio was sent", async () => {
  const { client, socket } = await connected();
  const stop = client.disconnect();
  socket.event({ type: "transcription.done", text: "" });
  assert.deepEqual(await stop, { text: "" });
});

test("drain timeout preserves received text and reports missing final words", async () => {
  const { client, socket } = await connected({ drainTimeoutMs: 5 });
  const errors = [];
  client.onError = (error) => errors.push(error.message);
  socket.event({ type: "transcription.text.delta", text: "texte reçu" });
  assert.deepEqual(await client.disconnect(), { text: "texte reçu" });
  assert.match(errors[0], /final words may be missing/);
  assert.deepEqual(client.completedSegments, ["texte reçu"]);
});

test("a connection closed during stop reports incomplete finalization", async () => {
  const { client, socket } = await connected();
  const errors = [];
  client.onError = (error) => errors.push(error.message);
  socket.event({ type: "transcription.text.delta", text: "texte reçu" });
  const stop = client.disconnect();
  socket.emit("close", 1006);
  assert.deepEqual(await stop, { text: "texte reçu" });
  assert.match(errors[0], /final words may be missing/);
});

test("authentication failures reject startup without exposing transport credentials", async () => {
  const socket = new Socket();
  const client = new Streaming(() => socket);
  const pending = client.connect({ apiKey: "private-key" });
  socket.emit("error", new Error("Unexpected server response: 401 private-key"));
  await assert.rejects(
    pending,
    (error) => /rejected your API key/.test(error.message) && !error.message.includes("private-key")
  );
  assert.equal(client.isConnected, false);
});

test("protocol errors sanitize provider payloads and notify recovery once", async () => {
  for (const [code, message] of [
    ["rate_limit_exceeded", /rate-limited/],
    ["insufficient_quota", /out of credit/],
    ["403", /denied access/],
  ]) {
    const { client, socket } = await connected();
    const errors = [];
    client.onConnectionLost = (error) => errors.push(error.message);
    socket.event({ type: "error", error: { code, message: "private-key" } });
    assert.equal(errors.length, 1);
    assert.match(errors[0], message);
    assert.ok(!errors[0].includes("private-key"));
    assert.equal(client.sendAudio(Buffer.alloc(2)), false);
  }
});

test("a lost connection commits the received suffix and old socket events cannot duplicate it", async () => {
  const { client, socket } = await connected();
  const finals = [];
  let losses = 0;
  client.onFinalTranscript = () => finals.push(client.completedSegments.at(-1));
  client.onConnectionLost = () => losses++;
  socket.event({ type: "transcription.text.delta", text: "première connexion" });
  socket.emit("close", 1006);
  assert.equal(losses, 1);
  assert.deepEqual(finals, ["première connexion"]);
  const replacement = new Socket();
  client.createSocket = () => replacement;
  const pending = client.connect({ apiKey: "test-secret" });
  replacement.event({ type: "session.created" });
  replacement.event({ type: "session.updated" });
  await pending;
  socket.event({ type: "transcription.done", text: "première connexion" });
  replacement.event({ type: "transcription.text.delta", text: "Deuxième connexion." });
  assert.deepEqual(finals, ["première connexion", "Deuxième connexion."]);
  client.cleanup();
});

test("connection timeout and cancellation settle startup and release the socket", async () => {
  const client = new Streaming(() => new Socket());
  await assert.rejects(client.connect({ apiKey: "key", connectTimeoutMs: 5 }), /took too long/);
  assert.equal(client.ws, null);
  const pending = client.connect({ apiKey: "key" });
  const rejected = assert.rejects(pending, /Cancelled/);
  await client.disconnect();
  await rejected;
});

test("cleanup cancels an in-flight handshake and releases the socket", async () => {
  const socket = new Socket();
  socket.readyState = 0;
  const client = new Streaming(() => socket);
  const pending = client.connect({ apiKey: "key" });
  const rejected = assert.rejects(pending, /Cancelled/);
  client.cleanup();
  await rejected;
  assert.equal(socket.readyState, 3);
  assert.equal(client.ws, null);
  assert.equal(client.isConnecting, false);
});

test("cleanup settles a pending drain and prevents it from closing a replacement socket", async () => {
  const { client, socket } = await connected();
  socket.event({ type: "transcription.text.delta", text: "received suffix" });
  const pending = client.disconnect();
  client.cleanup();
  await assert.rejects(client.connect({ apiKey: "key" }), /already open/);
  assert.deepEqual(await pending, { text: "received suffix" });
  assert.deepEqual(client.completedSegments, ["received suffix"]);
  assert.equal(client.finishDrain, null);
});

test("abort-style disconnect closes immediately without sending an end-of-audio request", async () => {
  const { client, socket } = await connected();
  socket.event({ type: "transcription.text.delta", text: "received suffix" });
  assert.deepEqual(await client.disconnect({ commit: false }), { text: "received suffix" });
  assert.deepEqual(
    socket.sent.map(({ type }) => type),
    ["session.update"]
  );
  assert.equal(socket.readyState, 3);
  assert.equal(client.isConnected, false);
});

test("an abort also settles a graceful disconnect already waiting for the server", async () => {
  const { client, socket } = await connected();
  const pending = client.disconnect();
  assert.deepEqual(await client.disconnect({ commit: false }), { text: "" });
  await pending;
  assert.equal(socket.readyState, 3);
  assert.equal(client.finishDrain, null);
});

test("session configuration send failures reject startup with a sanitized error", async () => {
  const socket = new Socket();
  const client = new Streaming(() => socket);
  const pending = client.connect({ apiKey: "private-key" });
  socket.send = () => {
    throw new Error("transport private-key");
  };
  assert.doesNotThrow(() => socket.event({ type: "session.created" }));
  await assert.rejects(pending, /Couldn't reach Mistral/);
  assert.equal(client.ws, null);
});

test("invalid messages and a rejected audio format cannot start capture", async () => {
  for (const event of [
    "not-json",
    "null",
    "[]",
    "{}",
    JSON.stringify({
      type: "session.updated",
      session: { audio_format: { encoding: "pcm_s16le", sample_rate: 16000 } },
    }),
  ]) {
    const socket = new Socket();
    const client = new Streaming(() => socket);
    const pending = client.connect({ apiKey: "key" });
    socket.emit("message", Buffer.from(event));
    await assert.rejects(pending, /invalid realtime message|audio format/);
    assert.equal(client.isConnected, false);
  }
});

test("a real WebSocket handshake streams PCM and drains the final words exactly once", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const requests = [];
  let authorization;
  server.on("connection", (socket, request) => {
    authorization = request.headers.authorization;
    const send = (event) => socket.send(JSON.stringify(event));
    send({ type: "session.created" });
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      requests.push(event);
      if (event.type === "session.update") {
        send({ type: "session.updated", session: event.session });
      } else if (event.type === "input_audio.append") {
        send({ type: "transcription.text.delta", text: "First sentence. Last" });
      } else if (event.type === "input_audio.end") {
        send({ type: "transcription.text.delta", text: " words." });
        send({ type: "transcription.done", text: "First sentence. Last words." });
      }
    });
  });
  const client = new Streaming(
    (_url, options) => new WebSocket(`ws://127.0.0.1:${server.address().port}`, options)
  );
  t.after(() => client.cleanup());
  const finals = [];
  client.onFinalTranscript = () => finals.push(client.completedSegments.at(-1));
  await client.connect({ apiKey: "test-key" });
  assert.equal(client.sendAudio(Buffer.from([0, 1, 2, 3])), true);
  assert.deepEqual(await client.disconnect(), { text: "First sentence. Last words." });
  assert.equal(authorization, "Bearer test-key");
  assert.deepEqual(
    requests.map(({ type }) => type),
    ["session.update", "input_audio.append", "input_audio.end"]
  );
  assert.equal(requests[1].audio, "AAECAw==");
  assert.deepEqual(finals, ["First sentence.", "Last words."]);
});
