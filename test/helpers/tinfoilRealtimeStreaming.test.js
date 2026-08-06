const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const WS = require("ws");

const load = () => import("../../src/helpers/tinfoilRealtimeStreaming.js");

const DELTA_EVENT = "conversation.item.input_audio_transcription.delta";
const COMPLETED_EVENT = "conversation.item.input_audio_transcription.completed";

function makeFakeSocket(readyState) {
  const socket = new EventEmitter();
  socket.readyState = readyState;
  socket.sent = [];
  socket.send = (data) => socket.sent.push(data);
  // A healthy connection answers pings, or the keep-alive terminates it mid-test.
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
  const factory = async (args) => {
    calls.push(args);
    return socket;
  };
  return { factory, calls };
}

function sentCommits(socket) {
  return socket.sent.filter((raw) => JSON.parse(raw).type === "input_audio_buffer.commit");
}

function delta(text) {
  return JSON.stringify({ type: DELTA_EVENT, delta: text });
}

function completed(transcript) {
  return JSON.stringify({ type: COMPLETED_EVENT, transcript });
}

function commitEmptyError() {
  return JSON.stringify({
    type: "error",
    error: { code: "input_audio_buffer_commit_empty", message: "buffer too small" },
  });
}

// Wires a connected instance directly, mirroring the existing realtime test
// style: cadence behavior is driven through handleMessage + mocked timers.
async function makeConnected() {
  const { TinfoilRealtimeStreaming } = await load();
  const streaming = new TinfoilRealtimeStreaming();
  streaming.ws = makeFakeSocket(WS.OPEN);
  streaming._markConnected();
  return streaming;
}

// -- connect: attested socket factory --

test("connect() passes the configured model and key to the attested socket factory", async () => {
  const { TinfoilRealtimeStreaming } = await load();
  const socket = makeFakeSocket(WS.CONNECTING);
  const { factory, calls } = makeRecordingFactory(socket);
  const streaming = new TinfoilRealtimeStreaming(factory);

  const connected = streaming.connect({ apiKey: "tk-secret", model: "custom-rt-model" });
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));
  socket.emit("message", JSON.stringify({ type: "session.updated" }));
  await connected;

  assert.deepEqual(calls, [{ model: "custom-rt-model", apiKey: "tk-secret" }]);
  streaming.cleanup();
});

test("connect() defaults the model to voxtral-mini-4b-realtime when the caller omits one", async () => {
  const { TinfoilRealtimeStreaming, TINFOIL_REALTIME_MODEL } = await load();
  const socket = makeFakeSocket(WS.CONNECTING);
  const { factory, calls } = makeRecordingFactory(socket);
  const streaming = new TinfoilRealtimeStreaming(factory);

  const connected = streaming.connect({ apiKey: "tk-secret" });
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));
  socket.emit("message", JSON.stringify({ type: "session.updated" }));
  await connected;

  assert.equal(calls[0].model, TINFOIL_REALTIME_MODEL);
  assert.equal(TINFOIL_REALTIME_MODEL, "voxtral-mini-4b-realtime");
  streaming.cleanup();
});

test("connect() overrides a caller-supplied createSocket with the attested factory", async () => {
  const { TinfoilRealtimeStreaming } = await load();
  const socket = makeFakeSocket(WS.CONNECTING);
  const { factory, calls } = makeRecordingFactory(socket);
  const streaming = new TinfoilRealtimeStreaming(factory);
  let rogueCalled = false;

  const connected = streaming.connect({
    apiKey: "tk-secret",
    createSocket: async () => {
      rogueCalled = true;
      return makeFakeSocket(WS.OPEN);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));
  socket.emit("message", JSON.stringify({ type: "session.updated" }));
  await connected;

  assert.equal(rogueCalled, false, "audio must only travel over the attested socket");
  assert.equal(calls.length, 1);
  streaming.cleanup();
});

test("the default socket factory is the attested Tinfoil transport", async () => {
  const { TinfoilRealtimeStreaming } = await load();
  const { createTinfoilRealtimeSocket } = require("../../src/helpers/tinfoilSecureClient");

  const streaming = new TinfoilRealtimeStreaming();

  assert.equal(streaming._createSocketImpl, createTinfoilRealtimeSocket);
});

test("factory failure rejects connect() without constructing any fallback socket", async () => {
  const { TinfoilRealtimeStreaming } = await load();
  const streaming = new TinfoilRealtimeStreaming(async () => {
    throw new Error("attestation failed");
  });

  await assert.rejects(() => streaming.connect({ apiKey: "tk-secret" }), /attestation failed/);

  assert.equal(streaming.ws, null, "no socket of any kind may exist after a factory failure");
  assert.equal(streaming.isConnecting, false);
  assert.equal(streaming.isConnected, false);
});

test("each fresh instance re-invokes the factory (meeting reconnect swaps instances)", async () => {
  const { TinfoilRealtimeStreaming } = await load();
  const calls = [];

  for (let i = 0; i < 2; i++) {
    const socket = makeFakeSocket(WS.CONNECTING);
    const streaming = new TinfoilRealtimeStreaming(async (args) => {
      calls.push(args);
      return socket;
    });
    const connected = streaming.connect({ apiKey: "tk-secret" });
    await new Promise((resolve) => setImmediate(resolve));
    socket.readyState = WS.OPEN;
    socket.emit("message", JSON.stringify({ type: "session.created" }));
    socket.emit("message", JSON.stringify({ type: "session.updated" }));
    await connected;
    streaming.cleanup();
  }

  assert.equal(calls.length, 2, "every connect must dial a fresh attested socket");
  assert.deepEqual(calls[0], calls[1]);
});

// -- session configuration --

test("connect() sends the GA transcription session.update declaring the 24kHz meeting rate", async () => {
  const { TinfoilRealtimeStreaming } = await load();
  const socket = makeFakeSocket(WS.CONNECTING);
  const { factory } = makeRecordingFactory(socket);
  const streaming = new TinfoilRealtimeStreaming(factory);

  const connected = streaming.connect({ apiKey: "tk-secret" });
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));

  assert.equal(socket.sent.length, 1);
  const update = JSON.parse(socket.sent[0]);
  assert.equal(update.type, "session.update");
  assert.equal(update.session.type, "transcription");
  assert.deepEqual(update.session.audio.input.format, { type: "audio/pcm", rate: 24000 });
  assert.equal(update.session.audio.input.transcription.model, "voxtral-mini-4b-realtime");

  socket.emit("message", JSON.stringify({ type: "session.updated" }));
  await connected;
  streaming.cleanup();
});

test("preconfigured sessions get no session.update (dictation semantics survive subclassing)", async () => {
  const { TinfoilRealtimeStreaming } = await load();
  const socket = makeFakeSocket(WS.CONNECTING);
  const { factory } = makeRecordingFactory(socket);
  const streaming = new TinfoilRealtimeStreaming(factory);

  const connected = streaming.connect({ apiKey: "tk-secret", preconfigured: true });
  await new Promise((resolve) => setImmediate(resolve));
  socket.readyState = WS.OPEN;
  socket.emit("message", JSON.stringify({ type: "session.created" }));
  await connected;

  assert.equal(socket.sent.length, 0, "session.update must not override a preconfigured session");
  streaming.cleanup();
});

// -- client-side utterance commits (Tinfoil has no server VAD) --

test("commits after the delta stream goes idle for the silence window", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();

    streaming.handleMessage(delta("hello"));
    t.mock.timers.tick(500);
    assert.equal(sentCommits(streaming.ws).length, 0, "no commit while under the idle window");

    t.mock.timers.tick(250);
    const commits = sentCommits(streaming.ws);
    assert.equal(commits.length, 1);
    assert.deepEqual(JSON.parse(commits[0]), { type: "input_audio_buffer.commit" });
  })();
});

test("keeps streaming without commits while deltas keep arriving", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();

    for (let i = 0; i < 8; i++) {
      streaming.handleMessage(delta("word "));
      t.mock.timers.tick(250);
    }

    assert.equal(sentCommits(streaming.ws).length, 0, "an active utterance must not be split");
  })();
});

test("commits a continuous utterance at the max-utterance cap", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();

    for (let i = 0; i < 118; i++) {
      streaming.handleMessage(delta("word "));
      t.mock.timers.tick(250);
    }
    assert.equal(sentCommits(streaming.ws).length, 0, "cap must not fire before 30s");

    for (let i = 0; i < 4; i++) {
      streaming.handleMessage(delta("word "));
      t.mock.timers.tick(250);
    }
    assert.equal(sentCommits(streaming.ws).length, 1, "cap must bound an endless utterance");
  })();
});

test("never commits while nothing has been transcribed (empty-buffer guard)", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();

    t.mock.timers.tick(5000);

    assert.equal(streaming.ws.sent.length, 0, "silence must never produce a commit");
  })();
});

test("one commit in flight at a time; completed re-arms the next utterance", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    const finals = [];
    streaming.onFinalTranscript = (text) => finals.push(text);

    streaming.handleMessage(delta("first utterance"));
    t.mock.timers.tick(850);
    assert.equal(sentCommits(streaming.ws).length, 1);

    t.mock.timers.tick(850);
    assert.equal(sentCommits(streaming.ws).length, 1, "no second commit before the server answers");

    streaming.handleMessage(completed("first utterance"));
    streaming.handleMessage(delta("second utterance"));
    t.mock.timers.tick(850);
    assert.equal(sentCommits(streaming.ws).length, 2, "next utterance must commit again");
    assert.deepEqual(finals, ["first utterance"], "finalized text must still reach the consumer");
  })();
});

test("an unanswered commit re-arms after the ack deadline instead of stalling the session", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();

    streaming.handleMessage(delta("hello"));
    t.mock.timers.tick(850);
    assert.equal(sentCommits(streaming.ws).length, 1);

    t.mock.timers.tick(10250);
    assert.equal(sentCommits(streaming.ws).length, 2, "session must self-heal after a lost commit");
  })();
});

test("first delta stamps speechStartedAt for the mic-suppression window", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    assert.equal(streaming.speechStartedAt, null);

    t.mock.timers.tick(1000);
    streaming.handleMessage(delta("hello"));
    assert.equal(streaming.speechStartedAt, 101000);

    streaming.handleMessage(completed("hello"));
    assert.equal(streaming.speechStartedAt, null, "utterance boundary must reset the stamp");
  })();
});

test("cleanup() stops the commit timer so a dead instance never commits", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    const socket = streaming.ws;

    streaming.handleMessage(delta("hello"));
    streaming.cleanup();
    assert.equal(streaming._commitTimer, null);

    t.mock.timers.tick(5000);
    assert.equal(sentCommits(socket).length, 0);
  })();
});

// -- disconnect drain: an in-flight timer commit must finalize before the flush --

test("disconnect() drains the in-flight timer commit so the tail transcript still lands", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    const socket = streaming.ws;
    streaming.sendAudio(Buffer.alloc(480));

    streaming.handleMessage(delta("first utterance"));
    t.mock.timers.tick(850);
    assert.equal(sentCommits(socket).length, 1, "timer commit in flight");
    streaming.handleMessage(delta("tail spoken after the commit"));

    const disconnected = streaming.disconnect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sentCommits(socket).length, 1, "flush must wait for the in-flight commit");

    streaming.handleMessage(completed("first utterance"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sentCommits(socket).length, 2, "flush commit follows the drained completed");

    streaming.handleMessage(completed("tail spoken after the commit"));
    const result = await disconnected;
    assert.equal(result.text, "first utterance tail spoken after the commit");
  })();
});

test("disconnect() with an unanswered commit resolves within the bounded deadlines", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    streaming.sendAudio(Buffer.alloc(480));
    streaming.handleMessage(delta("hello"));
    t.mock.timers.tick(850);
    assert.equal(sentCommits(streaming.ws).length, 1);

    const disconnected = streaming.disconnect();
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(3000);
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(3000);
    const result = await disconnected;
    assert.equal(result.text, "", "resolves with accumulated text instead of hanging");
  })();
});

// -- empty-commit replies: benign for timer commits, bounded against loops --

test("empty-buffer reply to a timer commit is swallowed and retried after a fresh idle window", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    let surfaced = 0;
    streaming.onError = () => {
      surfaced += 1;
    };

    streaming.handleMessage(delta("hello"));
    t.mock.timers.tick(850);
    assert.equal(sentCommits(streaming.ws).length, 1);

    streaming.handleMessage(commitEmptyError());
    assert.equal(surfaced, 0, "benign empty reply must not reach the meeting error channel");
    assert.equal(streaming._commitInFlight, false);

    t.mock.timers.tick(250);
    assert.equal(sentCommits(streaming.ws).length, 1, "no instant re-commit before the idle window");
    t.mock.timers.tick(600);
    assert.equal(sentCommits(streaming.ws).length, 2, "retry follows a full idle window");
  })();
});

test("a second empty-buffer reply drops the unfinalizable partial instead of looping commits", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    let surfaced = 0;
    streaming.onError = () => {
      surfaced += 1;
    };

    streaming.handleMessage(delta("hello"));
    t.mock.timers.tick(850);
    streaming.handleMessage(commitEmptyError());
    t.mock.timers.tick(850);
    assert.equal(sentCommits(streaming.ws).length, 2, "one retry after the first empty reply");

    streaming.handleMessage(commitEmptyError());
    assert.equal(surfaced, 0);
    assert.equal(streaming.currentPartial, "", "unfinalizable partial dropped");
    assert.equal(streaming.speechStartedAt, null);

    t.mock.timers.tick(5000);
    assert.equal(sentCommits(streaming.ws).length, 2, "no commit loop after dropping the partial");
  })();
});

test("empty-buffer error with no timer commit in flight still reaches onError", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    let errMsg = null;
    streaming.onError = (err) => {
      errMsg = err.message;
    };

    streaming.handleMessage(commitEmptyError());

    assert.equal(errMsg, "buffer too small", "base disconnect-flush tolerance must still see it");
  })();
});

test("server errors during an in-flight commit still surface", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();
    let errMsg = null;
    streaming.onError = (err) => {
      errMsg = err.message;
    };

    streaming.handleMessage(delta("hello"));
    t.mock.timers.tick(850);
    streaming.handleMessage(
      JSON.stringify({ type: "error", error: { code: "server_error", message: "something broke" } })
    );

    assert.equal(errMsg, "something broke");
    assert.equal(streaming._commitInFlight, false);
  })();
});

// -- empty delta frames must not touch the utterance timers --

test("an empty delta frame does not stamp speechStartedAt", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();

    streaming.handleMessage(delta(""));
    assert.equal(streaming.speechStartedAt, null, "an empty frame is not speech");

    t.mock.timers.tick(250);
    streaming.handleMessage(delta("real"));
    assert.equal(streaming.speechStartedAt, 100250);
  })();
});

test("empty delta frames do not starve the idle commit", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 100000 });
  return (async () => {
    const streaming = await makeConnected();

    streaming.handleMessage(delta("hi"));
    t.mock.timers.tick(250);
    streaming.handleMessage(delta(""));
    t.mock.timers.tick(250);
    streaming.handleMessage(delta(""));
    t.mock.timers.tick(250);

    assert.equal(sentCommits(streaming.ws).length, 1, "empty frames must not reset the idle clock");
  })();
});
