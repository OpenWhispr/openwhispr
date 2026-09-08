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

function captureLogs(t) {
  const debugLogger = require("../../src/helpers/debugLogger");
  const entries = [];
  for (const level of ["debug", "warn", "error"]) {
    const original = debugLogger[level];
    debugLogger[level] = (message, meta) => entries.push({ level, message, meta });
    t.after(() => {
      debugLogger[level] = original;
    });
  }
  return entries;
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

test("BYOK session.update is byte-for-byte today's payload when no VAD/language/noise options are passed", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  const socket = makeFakeSocket(WS.CONNECTING);

  const connected = streaming.connect({
    apiKey: "sk-test",
    model: "gpt-4o-mini-transcribe",
    // Phase 1 will add these; today connect() must ignore them entirely.
    language: "en",
    keyterms: ["OpenWhispr"],
    sampleRate: 24000,
    createSocket: async () => socket,
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));

  const updates = socket.sent
    .map((raw) => JSON.parse(raw))
    .filter((e) => e.type === "session.update");
  assert.equal(updates.length, 1, "exactly one session.update after session.created");
  assert.deepEqual(updates[0], {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { model: "gpt-4o-mini-transcribe" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.6,
            silence_duration_ms: 600,
            prefix_padding_ms: 500,
          },
        },
      },
    },
  });

  socket.emit("message", JSON.stringify({ type: "session.updated" }));
  await connected;
  streaming.cleanup();
});

test("BYOK session.update is byte-for-byte the overridden payload when vadThreshold is passed (system socket)", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  const socket = makeFakeSocket(WS.CONNECTING);

  const connected = streaming.connect({
    apiKey: "sk-test",
    model: "gpt-4o-mini-transcribe",
    streamLabel: "system",
    vadThreshold: 0.3,
    createSocket: async () => socket,
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));

  const updates = socket.sent
    .map((raw) => JSON.parse(raw))
    .filter((e) => e.type === "session.update");
  assert.equal(updates.length, 1, "exactly one session.update after session.created");
  assert.deepEqual(updates[0], {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { model: "gpt-4o-mini-transcribe" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.3,
            silence_duration_ms: 600,
            prefix_padding_ms: 500,
          },
        },
      },
    },
  });

  socket.emit("message", JSON.stringify({ type: "session.updated" }));
  await connected;
  streaming.cleanup();
});

test("dictation-style connect (inputRate 16000, custom socket factory) declares the 16kHz format and the same VAD", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  const socket = makeFakeSocket(WS.CONNECTING);
  const factoryCalls = [];

  const connected = streaming.connect({
    apiKey: "tk-secret",
    model: "voxtral-mini-4b-realtime",
    inputRate: 16000,
    createSocket: () => {
      factoryCalls.push("called");
      return Promise.resolve(socket);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));

  const [update] = socket.sent
    .map((raw) => JSON.parse(raw))
    .filter((e) => e.type === "session.update");
  assert.equal(factoryCalls.length, 1);
  assert.deepEqual(update.session.audio.input.format, { type: "audio/pcm", rate: 16000 });
  assert.equal(update.session.audio.input.transcription.model, "voxtral-mini-4b-realtime");
  assert.deepEqual(update.session.audio.input.turn_detection, {
    type: "server_vad",
    threshold: 0.6,
    silence_duration_ms: 600,
    prefix_padding_ms: 500,
  });
  assert.equal("noise_reduction" in update.session.audio.input, false);
  assert.equal("language" in update.session.audio.input.transcription, false);

  socket.emit("message", JSON.stringify({ type: "session.updated" }));
  await connected;
  streaming.cleanup();
});

test("characterization: a final that lands during disconnect()'s commit window reaches onFinalTranscript WITHOUT its timestamp (Phase 1 forwards it)", async () => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  const socket = makeFakeSocket(WS.CONNECTING);
  await connectPreconfigured(streaming, socket);

  const calls = [];
  streaming.onFinalTranscript = (text, timestamp) => calls.push({ text, timestamp });
  streaming.sendAudio(Buffer.alloc(1600, 1)); // audioBytesSent > 0 so disconnect() commits

  const disconnecting = streaming.disconnect();
  await new Promise((resolve) => setImmediate(resolve));

  const commits = socket.sent
    .filter((raw) => typeof raw === "string")
    .map((raw) => JSON.parse(raw))
    .filter((e) => e.type === "input_audio_buffer.commit");
  assert.equal(commits.length, 1, "disconnect() commits the trailing buffer");

  socket.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  socket.emit(
    "message",
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "tail words",
    })
  );
  const result = await disconnecting;

  assert.equal(result.text, "tail words", "the tail is returned to the caller");
  assert.equal(calls.length, 1, "the tail also reaches the live onFinalTranscript handler");
  assert.equal(calls[0].text, "tail words");
  // TODAY the temporary onFinalTranscript wrapper that disconnect() installs while
  // awaiting the commit forwards only `text` to the previous handler.
  // Phase 1 changes this line to `typeof calls[0].timestamp === "number"`.
  assert.equal(calls[0].timestamp, undefined);
});

// -- diagnostic logging: stream labels, VAD events, failed/empty turns --

test("transcription.failed is logged with the stream label and stays log-only (no onError, no segment)", async (t) => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  streaming.streamLabel = "system";
  const logs = captureLogs(t);
  let errorCalled = false;
  streaming.onError = () => {
    errorCalled = true;
  };

  streaming.handleMessage(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "item_1",
      error: { code: "audio_unintelligible", message: "audio too noisy" },
    })
  );

  const line = logs.find((entry) => entry.message.includes("turn transcription failed"));
  assert.ok(line, "failed turn must produce a debug line");
  assert.equal(line.level, "debug");
  assert.equal(line.meta.stream, "system");
  assert.equal(line.meta.itemId, "item_1");
  assert.equal(line.meta.error, "audio too noisy");
  assert.equal(errorCalled, false, "failed turns must not surface as errors");
  assert.equal(streaming.completedSegments.length, 0, "failed turns must not count as segments");
});

test("empty-transcript completed events are logged and add no segment", async (t) => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  streaming.streamLabel = "system";
  streaming.audioBytesSent = 4800;
  const logs = captureLogs(t);
  let finalCalled = false;
  streaming.onFinalTranscript = () => {
    finalCalled = true;
  };

  streaming.handleMessage(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_2",
      transcript: "   ",
    })
  );

  const line = logs.find((entry) => entry.message.includes("turn completed with empty transcript"));
  assert.ok(line, "empty completion must produce a debug line");
  assert.equal(line.meta.stream, "system");
  assert.equal(line.meta.itemId, "item_2");
  assert.equal(line.meta.audioBytesSent, 4800);
  assert.equal(finalCalled, false);
  assert.equal(streaming.completedSegments.length, 0);
});

test("VAD events log first-3-then-every-50th with streamLabel and audioBytesSent", async (t) => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  streaming.streamLabel = "system";
  streaming.audioBytesSent = 1234;
  const logs = captureLogs(t);
  const vadLines = () => logs.filter((entry) => entry.message.includes("VAD event"));

  streaming.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  streaming.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
  streaming.handleMessage(JSON.stringify({ type: "input_audio_buffer.committed" }));
  assert.equal(vadLines().length, 3, "first 3 events all log");
  assert.equal(vadLines()[0].meta.stream, "system");
  assert.equal(vadLines()[0].meta.event, "input_audio_buffer.speech_started");
  assert.equal(vadLines()[0].meta.audioBytesSent, 1234);

  // Events 4..49 are throttled; the 50th logs again.
  for (let i = 4; i <= 49; i++) {
    streaming.handleMessage(JSON.stringify({ type: "input_audio_buffer.committed" }));
  }
  assert.equal(vadLines().length, 3, "events 4..49 stay silent");
  streaming.handleMessage(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  assert.equal(vadLines().length, 4, "the 50th event logs");
  assert.equal(vadLines()[3].meta.count, 50);

  assert.equal(streaming.speechStartedCount, 2, "only speech_started increments the counter");
});

test("disconnect summary carries streamLabel and speechStartedCount", async (t) => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  const socket = makeFakeSocket(WS.CONNECTING);
  const connected = streaming.connect({
    apiKey: "key",
    preconfigured: true,
    streamLabel: "system",
    createSocket: async () => socket,
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));
  await connected;

  socket.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  socket.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_started" }));

  const logs = captureLogs(t);
  await streaming.disconnect();

  const line = logs.find((entry) => entry.message === "OpenAI Realtime disconnect");
  assert.ok(line, "disconnect must log a summary");
  assert.equal(line.meta.stream, "system");
  assert.equal(line.meta.speechStartedCount, 2);
  assert.equal(line.meta.segments, 0);
  assert.equal(line.meta.audioBytesSent, 0);
});

test("preconfigured session.created echoes the server VAD config and format into the log", async (t) => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  const socket = makeFakeSocket(WS.CONNECTING);
  const logs = captureLogs(t);

  const connected = streaming.connect({
    apiKey: "key",
    preconfigured: true,
    streamLabel: "system",
    createSocket: async () => socket,
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit(
    "message",
    JSON.stringify({
      type: "session.created",
      session: {
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 600 },
          },
        },
      },
    })
  );
  await connected;

  const lines = logs.filter((entry) => entry.message.includes("session created (preconfigured)"));
  assert.equal(lines.length, 1, "server config echo logs once per socket");
  assert.equal(lines[0].meta.stream, "system");
  assert.deepEqual(lines[0].meta.turnDetection, {
    type: "server_vad",
    threshold: 0.5,
    silence_duration_ms: 600,
  });
  assert.deepEqual(lines[0].meta.inputFormat, { type: "audio/pcm", rate: 24000 });
  streaming.cleanup();
});

test("without a streamLabel (dictation) log metadata carries no stream key", async (t) => {
  const OpenAIRealtimeStreaming = (await load()).default;
  const streaming = new OpenAIRealtimeStreaming();
  const logs = captureLogs(t);

  await streaming.disconnect();

  const line = logs.find((entry) => entry.message === "OpenAI Realtime disconnect");
  assert.ok(line);
  assert.equal("stream" in line.meta, false, "unlabelled sockets keep today's metadata shape");
});
