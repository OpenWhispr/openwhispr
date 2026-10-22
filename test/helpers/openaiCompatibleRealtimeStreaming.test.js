const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const WS = require("ws");

const load = () => import("../../src/helpers/openaiCompatibleRealtimeStreaming.js");
const LAN_URL = "ws://192.168.1.20:9000/v1/realtime";

function makeFakeSocket(readyState) {
  const socket = new EventEmitter();
  socket.readyState = readyState;
  socket.sent = [];
  socket.send = (data) => socket.sent.push(data);
  socket.ping = () => socket.emit("pong");
  socket.terminate = () => {
    socket.readyState = WS.CLOSED;
    socket.emit("close", 1006, Buffer.from(""));
  };
  socket.close = () => {
    socket.readyState = WS.CLOSED;
  };
  return socket;
}

function makeRecordingFactory(socket) {
  const calls = [];
  return {
    calls,
    factory: async (args) => {
      calls.push(args);
      return socket;
    },
  };
}

function sentEvents(socket, type) {
  return socket.sent.map((raw) => JSON.parse(raw)).filter((event) => event.type === type);
}

async function finishConnect(socket) {
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));
  socket.emit("message", JSON.stringify({ type: "session.updated" }));
}

async function connectWith(options, socket = makeFakeSocket(WS.CONNECTING)) {
  const { OpenAICompatibleRealtimeStreaming } = await load();
  const { factory, calls } = makeRecordingFactory(socket);
  const streaming = new OpenAICompatibleRealtimeStreaming(factory);
  const connected = streaming.connect({ url: LAN_URL, ...options });
  await finishConnect(socket);
  await connected;
  return { streaming, socket, calls };
}

test("buildRealtimeUrl accepts wss anywhere and ws only on a private host", async () => {
  const { buildRealtimeUrl } = await load();

  for (const url of [
    "wss://stt.example.com/v1/realtime",
    "ws://localhost:9000/v1/realtime",
    "ws://127.0.0.1:9000/realtime",
    "ws://10.1.2.3/api/v1/realtime",
    "ws://172.16.0.4:9000/v1/realtime",
    "ws://box.local:9000/v1/realtime",
    "ws://box.tailnet.ts.net:9000/v1/realtime",
    "ws://[::1]:9000/v1/realtime",
  ]) {
    const built = new URL(buildRealtimeUrl(url, "m"));
    const typed = new URL(url);
    assert.equal(built.protocol, typed.protocol, url);
    assert.equal(built.host, typed.host, url);
    assert.equal(built.pathname, typed.pathname, url);
  }
});

test("buildRealtimeUrl rejects empty, non-WebSocket and public cleartext URLs", async () => {
  const { buildRealtimeUrl } = await load();

  for (const url of [undefined, null, "", "   "]) {
    assert.throws(() => buildRealtimeUrl(url, "m"), { message: "selfHostedRealtimeUrlMissing" });
  }
  for (const url of [
    "http://192.168.1.20:9000/v1/realtime",
    "https://stt.example.com/v1/realtime",
    "ftp://192.168.1.20/",
    "192.168.1.20:9000",
    "not a url",
    "ws://stt.example.com/v1/realtime",
    "ws://8.8.8.8:9000/v1/realtime",
    "ws://10.example.com/v1/realtime",
  ]) {
    assert.throws(
      () => buildRealtimeUrl(url, "m"),
      { message: "selfHostedRealtimeUrlInvalid" },
      url
    );
  }
});

test("buildRealtimeUrl puts the model in the query and keeps the rest of it", async () => {
  const { buildRealtimeUrl } = await load();

  const built = new URL(buildRealtimeUrl(LAN_URL, " whisper-large-v3-turbo "));
  assert.equal(built.pathname, "/v1/realtime");
  assert.equal(built.searchParams.get("model"), "whisper-large-v3-turbo");
  assert.equal(built.searchParams.get("intent"), "transcription");

  const kept = new URL(buildRealtimeUrl(`${LAN_URL}?token=abc&intent=conversation`, "whisper"));
  assert.equal(kept.searchParams.get("token"), "abc");
  assert.equal(kept.searchParams.get("intent"), "conversation");
  assert.equal(kept.searchParams.get("model"), "whisper");

  // The typed model wins over one already in the URL; an empty one leaves it alone.
  assert.equal(
    new URL(buildRealtimeUrl(`${LAN_URL}?model=old`, "new")).searchParams.get("model"),
    "new"
  );
  assert.equal(
    new URL(buildRealtimeUrl(`${LAN_URL}?model=old`, "")).searchParams.get("model"),
    "old"
  );
  assert.equal(new URL(buildRealtimeUrl(LAN_URL, "")).searchParams.has("model"), false);
});

test("connect dials only the configured server, through the factory", async () => {
  const { calls, streaming } = await connectWith({ model: "whisper", apiKey: "" });

  assert.equal(calls.length, 1);
  const dialed = new URL(calls[0].url);
  assert.equal(dialed.host, "192.168.1.20:9000");
  assert.equal(dialed.searchParams.get("model"), "whisper");
  assert.equal(streaming.isConnected, true);
  streaming.cleanup();
});

test("the default socket sends a Bearer header only when a key is set", async (t) => {
  const { OpenAICompatibleRealtimeStreaming } = await load();
  const seen = [];
  const { WebSocketServer } = WS;
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  server.on("connection", (socket, request) => {
    seen.push({ url: request.url, authorization: request.headers.authorization });
    socket.send(JSON.stringify({ type: "session.created" }));
    socket.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "session.update") {
        socket.send(JSON.stringify({ type: "session.updated" }));
      }
    });
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `ws://127.0.0.1:${server.address().port}/v1/realtime`;

  for (const apiKey of ["sk-local", "", undefined]) {
    const streaming = new OpenAICompatibleRealtimeStreaming();
    await streaming.connect({ url, model: "whisper", apiKey });
    await streaming.disconnect();
  }

  assert.equal(seen.length, 3);
  assert.equal(seen[0].authorization, "Bearer sk-local");
  assert.equal(seen[1].authorization, undefined);
  assert.equal(seen[2].authorization, undefined);
  assert.match(seen[0].url, /model=whisper/);
});

test("the session declares 16 kHz and 24 kHz capture is downsampled to 2/3", async () => {
  const { streaming, socket } = await connectWith({
    model: "whisper",
    apiKey: "",
    // What ipcHandlers passes for a meeting stream.
    sampleRate: 24000,
  });

  const [update] = sentEvents(socket, "session.update");
  assert.equal(update.session.audio.input.format.rate, 16000);
  assert.equal(update.session.audio.input.transcription.model, "whisper");

  const captured = Buffer.alloc(2400 * 2); // 100 ms at 24 kHz
  assert.equal(streaming.sendAudio(captured), true);
  const [append] = sentEvents(socket, "input_audio_buffer.append");
  assert.equal(Buffer.from(append.audio, "base64").length, 1600 * 2); // 100 ms at 16 kHz
  streaming.cleanup();
});

test("a self-hosted session is configured by the client even outside BYOK", async () => {
  // ipcHandlers marks every non-BYOK meeting session preconfigured; no server
  // pre-configures this one, so the client must still send session.update.
  const { streaming, socket } = await connectWith({
    model: "whisper",
    apiKey: "",
    mode: "self-hosted",
    preconfigured: true,
  });

  assert.equal(sentEvents(socket, "session.update").length, 1);
  streaming.cleanup();
});

test("connection logs never carry the OpenAI Realtime label", async () => {
  const debugLogger = require("../../src/helpers/debugLogger");
  const messages = [];
  const levels = ["debug", "info", "warn", "error"];
  const originals = Object.fromEntries(levels.map((level) => [level, debugLogger[level]]));
  for (const level of levels) {
    debugLogger[level] = (message) => messages.push(message);
  }
  try {
    const { streaming } = await connectWith({ model: "whisper", apiKey: "" });
    await streaming.disconnect();
  } finally {
    for (const level of levels) debugLogger[level] = originals[level];
  }

  assert.ok(
    messages.some((message) => message.startsWith("OpenAI-compatible Realtime")),
    JSON.stringify(messages)
  );
  assert.deepEqual(
    messages.filter((message) => message.startsWith("OpenAI Realtime")),
    [],
    "a self-hosted session must never log as OpenAI"
  );
});

test("a failing socket factory rejects without dialing anything else", async () => {
  const { OpenAICompatibleRealtimeStreaming } = await load();
  let calls = 0;
  const streaming = new OpenAICompatibleRealtimeStreaming(async () => {
    calls += 1;
    throw new Error("ECONNREFUSED");
  });

  await assert.rejects(streaming.connect({ url: LAN_URL, model: "whisper" }), /ECONNREFUSED/);
  assert.equal(calls, 1);
  assert.equal(streaming.ws, null);
  assert.equal(streaming.isConnecting, false);
});

test("an invalid URL rejects before any socket is created", async () => {
  const { OpenAICompatibleRealtimeStreaming } = await load();
  let calls = 0;
  const streaming = new OpenAICompatibleRealtimeStreaming(async () => {
    calls += 1;
    return makeFakeSocket(WS.OPEN);
  });

  await assert.rejects(streaming.connect({ url: "ws://stt.example.com/v1/realtime" }), {
    message: "selfHostedRealtimeUrlInvalid",
  });
  await assert.rejects(streaming.connect({ url: "" }), {
    message: "selfHostedRealtimeUrlMissing",
  });
  assert.equal(calls, 0);
});

test("a server that never confirms the session times out with no fallback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { OpenAICompatibleRealtimeStreaming } = await load();
  const socket = makeFakeSocket(WS.CONNECTING);
  const { factory, calls } = makeRecordingFactory(socket);
  const streaming = new OpenAICompatibleRealtimeStreaming(factory);

  const connected = streaming.connect({ url: LAN_URL, model: "whisper" });
  // Let the factory resolve and the handlers attach (setImmediate is not mocked).
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(streaming.ws, socket);
  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));
  t.mock.timers.tick(15000);

  await assert.rejects(connected, /OpenAI-compatible Realtime connection timeout/);
  assert.equal(calls.length, 1);
  assert.equal(streaming.isConnected, false);
});

test("a blank model is refused before dialing, never sent as the OpenAI default", async () => {
  const { OpenAICompatibleRealtimeStreaming } = await load();
  let calls = 0;
  const streaming = new OpenAICompatibleRealtimeStreaming(async () => {
    calls += 1;
    return makeFakeSocket(WS.OPEN);
  });

  // A non-string from a bad renderer is a sentinel too, not a TypeError.
  for (const model of [undefined, null, "", "   ", 42, {}]) {
    await assert.rejects(
      streaming.connect({ url: LAN_URL, model }),
      { message: "selfHostedRealtimeModelMissing" },
      JSON.stringify(model)
    );
  }
  await assert.rejects(streaming.connect({ url: `${LAN_URL}?model=%20%20` }), {
    message: "selfHostedRealtimeModelMissing",
  });
  assert.equal(calls, 0);
});

test("a model given only in the URL query is the one the session declares", async () => {
  const { OpenAICompatibleRealtimeStreaming } = await load();
  const socket = makeFakeSocket(WS.CONNECTING);
  const { factory, calls } = makeRecordingFactory(socket);
  const streaming = new OpenAICompatibleRealtimeStreaming(factory);
  const connected = streaming.connect({ url: `${LAN_URL}?model=Whisper-Large-v3-Turbo` });
  await finishConnect(socket);
  await connected;

  assert.equal(new URL(calls[0].url).searchParams.get("model"), "Whisper-Large-v3-Turbo");
  const [update] = sentEvents(socket, "session.update");
  assert.equal(update.session.audio.input.transcription.model, "Whisper-Large-v3-Turbo");
  assert.doesNotMatch(JSON.stringify(socket.sent), /gpt-4o/);
  streaming.cleanup();
});

test("stop waits for a turn the server acked without an item_id (Lemonade)", async () => {
  const { streaming, socket } = await connectWith({ model: "whisper", apiKey: "" });
  assert.equal(streaming.sendAudio(Buffer.alloc(4800)), true);

  // A VAD turn mid-recording, all without item ids.
  socket.emit("message", JSON.stringify({ type: "input_audio_buffer.committed" }));
  socket.emit(
    "message",
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "first turn",
    })
  );

  let settled = false;
  const stopped = streaming.disconnect().then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentEvents(socket, "input_audio_buffer.commit").length, 1);

  socket.emit("message", JSON.stringify({ type: "input_audio_buffer.committed" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the ack alone must not end the wait");

  socket.emit(
    "message",
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "last turn",
    })
  );
  const result = await stopped;
  assert.match(result.text, /first turn/);
  assert.match(result.text, /last turn/);
});

test("a server that names its items is tracked by those names", async () => {
  const { streaming, socket } = await connectWith({ model: "whisper", apiKey: "" });
  streaming.sendAudio(Buffer.alloc(4800));
  const stopped = streaming.disconnect();
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit("message", JSON.stringify({ type: "input_audio_buffer.committed", item_id: "a" }));
  socket.emit(
    "message",
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "a",
      transcript: "named turn",
    })
  );
  assert.match((await stopped).text, /named turn/);
});

test("stop settles at once when the server clears an empty commit (Lemonade)", async () => {
  const { streaming, socket } = await connectWith({ model: "whisper", apiKey: "" });
  streaming.sendAudio(Buffer.alloc(4800));

  // Silence closed the turn and its transcript arrived before stop.
  socket.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  socket.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
  socket.emit(
    "message",
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "only turn",
    })
  );

  let settled = false;
  const stopped = streaming.disconnect().then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit("message", JSON.stringify({ type: "input_audio_buffer.cleared" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, true, "cleared must end the wait, not the 3 s timeout");
  assert.match((await stopped).text, /only turn/);
});

test("a cleared commit still waits for a silence-closed turn in flight", async () => {
  const { streaming, socket } = await connectWith({ model: "whisper", apiKey: "" });
  streaming.sendAudio(Buffer.alloc(4800));

  socket.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  socket.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));

  let settled = false;
  const stopped = streaming.disconnect().then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.emit("message", JSON.stringify({ type: "input_audio_buffer.cleared" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the turn closed on silence has not been transcribed yet");

  socket.emit(
    "message",
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "late turn",
    })
  );
  assert.match((await stopped).text, /late turn/);
});

test("each transcript keeps its own turn's start time when turns overlap", async (t) => {
  const { streaming, socket } = await connectWith({ model: "whisper", apiKey: "" });
  const stamps = [];
  streaming.onFinalTranscript = (_text, timestamp) => stamps.push(timestamp);

  let now = 1000;
  t.mock.method(Date, "now", () => now);

  // Continuous speech: the second turn starts before the first is transcribed.
  socket.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  now = 4000;
  socket.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
  socket.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  now = 4600;
  socket.emit(
    "message",
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "first speaker",
    })
  );
  now = 7000;
  socket.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
  now = 7600;
  socket.emit(
    "message",
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "second speaker",
    })
  );

  assert.deepEqual(stamps, [1000, 4000]);
  await streaming.disconnect();
});
