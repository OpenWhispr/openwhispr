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

async function connectPreconfigured(streaming, socket) {
  const connected = streaming.connect({
    apiKey: "key",
    preconfigured: true,
    createSocket: async () => socket,
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));
  await connected;
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

// -- session expiry (60-minute OpenAI Realtime session limit) --

test("session_expired error fires onSessionExpired instead of onError and sets the flag", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  let expiredCalled = false;
  let errorCalled = false;
  streaming.onSessionExpired = () => {
    expiredCalled = true;
  };
  streaming.onError = () => {
    errorCalled = true;
  };

  streaming.handleMessage(
    JSON.stringify({
      type: "error",
      error: { code: "session_expired", message: "Your session hit the maximum duration." },
    })
  );

  assert.equal(expiredCalled, true);
  assert.equal(errorCalled, false);
  assert.equal(streaming._sessionExpired, true);
});

test("session_expired without an onSessionExpired handler falls through to onError (dictation path)", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  let errorMessage = null;
  streaming.onError = (err) => {
    errorMessage = err.message;
  };

  streaming.handleMessage(
    JSON.stringify({
      type: "error",
      error: { code: "session_expired", message: "Your session hit the maximum duration." },
    })
  );

  assert.equal(errorMessage, "Your session hit the maximum duration.");
  assert.equal(streaming._sessionExpired, false);
});

test("non-session_expired error fires onError normally", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  let errorMsg = null;
  streaming.onError = (err) => {
    errorMsg = err.message;
  };

  streaming.handleMessage(
    JSON.stringify({
      type: "error",
      error: { code: "server_error", message: "something broke" },
    })
  );

  assert.equal(errorMsg, "something broke");
});

test("empty buffer error is not treated as session expiry", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  let expiredCalled = false;
  let errorCalled = false;
  streaming.onSessionExpired = () => {
    expiredCalled = true;
  };
  streaming.onError = () => {
    errorCalled = true;
  };

  streaming.handleMessage(
    JSON.stringify({
      type: "error",
      error: { code: "input_audio_buffer_commit_empty", message: "buffer too small" },
    })
  );

  assert.equal(expiredCalled, false);
  assert.equal(errorCalled, true);
});

test("close after session_expired does not fire onSessionEnd (reconnect owns the session)", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  const socket = makeFakeSocket(WS.CONNECTING);
  await connectPreconfigured(streaming, socket);

  let sessionEndCalled = false;
  streaming.onSessionEnd = () => {
    sessionEndCalled = true;
  };
  streaming.onSessionExpired = () => {};

  socket.emit(
    "message",
    JSON.stringify({ type: "error", error: { code: "session_expired", message: "expired" } })
  );
  socket.emit("close", 1000, Buffer.from(""));

  assert.equal(sessionEndCalled, false);
});

test("connect() resets _sessionExpired left over from a previous session", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  streaming._sessionExpired = true;

  const socket = makeFakeSocket(WS.CONNECTING);
  const connected = streaming.connect({
    apiKey: "key",
    preconfigured: true,
    createSocket: async () => socket,
  });
  assert.equal(streaming._sessionExpired, false, "flag must reset synchronously in connect()");

  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));
  await connected;
  streaming.cleanup();
});

// -- proactive session timer (fires before the 60-minute limit) --

test("session timer fires onSessionExpired at the pre-empt deadline while connected", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return (async () => {
    const OpenAIRealtimeStreaming = (await load()).default;
    const streaming = new OpenAIRealtimeStreaming();
    streaming.isConnected = true;
    let expiredCalls = 0;
    streaming.onSessionExpired = () => {
      expiredCalls += 1;
    };

    streaming._startSessionTimer();

    t.mock.timers.tick(55 * 60 * 1000 - 1);
    assert.equal(expiredCalls, 0);
    t.mock.timers.tick(1);
    assert.equal(expiredCalls, 1);
  })();
});

test("cleanup() clears the session timer so a stopped session never requests a reconnect", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return (async () => {
    const OpenAIRealtimeStreaming = (await load()).default;
    const streaming = new OpenAIRealtimeStreaming();
    streaming.isConnected = true;
    let expiredCalls = 0;
    streaming.onSessionExpired = () => {
      expiredCalls += 1;
    };

    streaming._startSessionTimer();
    streaming.cleanup();
    assert.equal(streaming._sessionTimer, null);

    t.mock.timers.tick(55 * 60 * 1000);
    assert.equal(expiredCalls, 0);
  })();
});

// -- reconnect flow: audio accounting across the session boundary --

test("zero audio loss during reactive reconnect (session_expired at 60min)", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const CHUNK = Buffer.alloc(480);

  // Phase 1: old instance streaming normally.
  const old = new OpenAIRealtimeStreaming();
  old.isConnected = true;
  old.ws = makeFakeSocket(WS.OPEN);
  for (let i = 0; i < 100; i++) old.sendAudio(CHUNK);
  assert.equal(old.ws.sent.length, 100, "all chunks sent to old ws");
  const oldSent = old.ws.sent;

  // Phase 2: session_expired fires, server closes the old ws.
  let expiredFired = false;
  old.onSessionExpired = () => {
    expiredFired = true;
  };
  old.handleMessage(
    JSON.stringify({ type: "error", error: { code: "session_expired", message: "60 minutes" } })
  );
  assert.equal(expiredFired, true);
  old.cleanup();
  assert.equal(
    old.sendAudio(CHUNK),
    false,
    "dead instance drops audio, but the swap already happened"
  );

  // Phase 3: reconnect swaps in a fresh instance before the token fetch;
  // beginConnecting() arms the pre-connect buffer for the fetch window.
  const fresh = new OpenAIRealtimeStreaming();
  fresh.beginConnecting();
  for (let i = 0; i < 50; i++) fresh.sendAudio(CHUNK);
  assert.equal(fresh.coldStartBuffer.length, 50, "pre-connect buffer caught all chunks");
  assert.equal(fresh.coldStartBufferSize, 50 * 480);

  // Phase 4: token received, socket still connecting.
  fresh.ws = makeFakeSocket(WS.CONNECTING);
  for (let i = 0; i < 20; i++) fresh.sendAudio(CHUNK);
  assert.equal(fresh.coldStartBuffer.length, 70, "buffer holds pre-connect + connecting chunks");

  // Phase 5: socket opens, next sendAudio flushes everything.
  fresh.ws = makeFakeSocket(WS.OPEN);
  fresh.sendAudio(CHUNK);
  assert.equal(fresh.coldStartBuffer.length, 0, "buffer flushed");
  assert.equal(fresh.ws.sent.length, 71, "all buffered + live chunks sent to new ws");

  assert.equal(oldSent.length + fresh.ws.sent.length, 171, "zero chunks dropped");
});

test("zero audio loss during proactive reconnect (timer before the limit)", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const CHUNK = Buffer.alloc(480);

  // Old instance still alive while the reconnect fetches a token.
  const old = new OpenAIRealtimeStreaming();
  old.isConnected = true;
  old.ws = makeFakeSocket(WS.OPEN);
  for (let i = 0; i < 100; i++) old.sendAudio(CHUNK);

  // Audio dispatched between the timer firing and the instance swap still
  // reaches the old, healthy connection.
  for (let i = 0; i < 10; i++) old.sendAudio(CHUNK);
  assert.equal(old.ws.sent.length, 110, "audio still flows to old instance during token fetch");

  // References swapped; new instance buffers until its socket opens.
  const fresh = new OpenAIRealtimeStreaming();
  fresh.beginConnecting();
  for (let i = 0; i < 30; i++) fresh.sendAudio(CHUNK);
  assert.equal(fresh.coldStartBuffer.length, 30);

  fresh.ws = makeFakeSocket(WS.OPEN);
  fresh.sendAudio(CHUNK);
  assert.equal(fresh.ws.sent.length, 31, "30 flushed + 1 live");
  assert.equal(fresh.coldStartBuffer.length, 0);

  assert.equal(old.ws.sent.length + fresh.ws.sent.length, 141, "zero chunks dropped");
});

test("concurrent session_expired from mic and system streams only reconnects once", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;

  // Mirrors the meetingReconnecting guard in ipcHandlers.
  let reconnectCalls = 0;
  let reconnecting = false;
  const guardedReconnect = () => {
    if (reconnecting) return;
    reconnecting = true;
    reconnectCalls++;
  };

  const mic = new OpenAIRealtimeStreaming();
  const system = new OpenAIRealtimeStreaming();
  mic.onSessionExpired = guardedReconnect;
  system.onSessionExpired = guardedReconnect;

  const expiredEvent = JSON.stringify({
    type: "error",
    error: { code: "session_expired", message: "expired" },
  });
  mic.handleMessage(expiredEvent);
  system.handleMessage(expiredEvent);

  assert.equal(reconnectCalls, 1, "reconnect called exactly once despite two streams expiring");
});

test("completedSegments accumulate across turns", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  let lastFull = "";
  streaming.onFinalTranscript = (text) => {
    lastFull = text;
  };

  streaming.handleMessage(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Hello world",
    })
  );
  streaming.handleMessage(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "How are you",
    })
  );

  assert.equal(streaming.completedSegments.length, 2);
  assert.equal(lastFull, "Hello world How are you");
});
