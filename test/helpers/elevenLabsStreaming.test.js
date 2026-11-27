const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { WebSocketServer } = require("ws");

const ElevenLabsStreaming = require("../../src/helpers/elevenLabsStreaming");
const debugLogger = require("../../src/helpers/debugLogger");

const FRAME_BYTES = 2400; // one 50 ms frame at 24 kHz
const PLAIN_COMMIT_GRACE_MS = 1500; // how long the client lets a plain commit wait for its twin

// Loopback Scribe Realtime server, with a client pointed at it. It starts the session
// a beat after the socket opens, so audio sent during the handshake shows up as held,
// and hands each test the socket so it can answer with transcripts and errors.
async function withScribeServer(run, { refuse = null } = {}) {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    ...(refuse ? { verifyClient: (_info, done) => done(false, refuse) } : {}),
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const sessions = [];
  // Both ends of every socket, each as the promise of its close.
  const closed = [];
  const watch = (socket) => closed.push(new Promise((resolve) => socket.once("close", resolve)));
  server.on("connection", (socket, request) => {
    const session = { socket, request, chunks: [], startSession: true };
    sessions.push(session);
    watch(socket);
    socket.on("message", (data) => session.chunks.push(JSON.parse(data.toString())));
    setTimeout(() => {
      if (session.startSession && socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify({
            message_type: "session_started",
            session_id: "s-1",
            config: { model_id: "scribe_v3_live" },
          })
        );
      }
    }, 50);
  });

  const streaming = new ElevenLabsStreaming();
  const url = `ws://127.0.0.1:${server.address().port}`;
  const build = streaming.buildWebSocketUrl.bind(streaming);
  streaming.buildWebSocketUrl = (options) => `${url}?${new URL(build(options)).searchParams}`;
  const attach = streaming.attachSocketHandlers.bind(streaming);
  streaming.attachSocketHandlers = (socket) => {
    watch(socket);
    attach(socket);
  };

  // node:test has no default timeout, and a test-level one would leave this server
  // listening: a timed-out test never reaches the finally. So the session is bounded
  // here, and an answer that never comes fails the run rather than hanging it. The
  // timer is set before the test runs, so a test's mocked clock cannot hold it.
  const outlasted = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("the session outlasted its test")), 10000).unref()
  );
  try {
    await Promise.race([run({ streaming, sessions }), outlasted]);
  } finally {
    streaming.cleanup();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    // ws clears a closing socket's 30 s timer when the socket closes. Under the next
    // test's mocked clock that would leave it running, so both ends close first.
    await Promise.all(closed);
  }
}

const send = (session, message) => session.socket.send(JSON.stringify(message));

async function deliver(streaming, session, ...messages) {
  for (const message of messages) {
    send(session, message);
    await once(streaming.ws, "message");
  }
}

const partial = (text) => ({ message_type: "partial_transcript", text });
const committed = (text) => ({ message_type: "committed_transcript", text });
const timed = (text, start) => ({
  message_type: "committed_transcript_with_timestamps",
  text,
  words: text ? [{ type: "word", start }] : null,
});
// Scribe sends each commit as two frames: a worded one plain first and its word
// times behind it, an empty one with its timestamped frame a few ms ahead.
const wordedCommit = (text, start) => [committed(text), timed(text, start)];
const EMPTY_COMMIT = [timed(""), committed("")];

// Answers a stop as Scribe does: the first of its three commits with `answer`, the
// two behind it empty.
function answerStop(session, answer) {
  let answered = false;
  session.socket.on("message", (data) => {
    if (answered || !JSON.parse(data.toString()).commit) return;
    answered = true;
    answer();
    for (const frame of [...EMPTY_COMMIT, ...EMPTY_COMMIT]) send(session, frame);
  });
}

const SPEECH = 8; // a sample fill above the level the client takes for a pause
const pcm = (ms, fill = 0) => Buffer.alloc(ms * 48, fill); // 24 kHz, 16-bit
const audioOf = (chunk) => Buffer.from(chunk.audio_base_64, "base64");

// The client's timers start with the session, on the real clock. A test that mocks
// the clock stops them first and starts them again on the mocked one.
function mockClock(t, streaming) {
  streaming.stopKeepAlive();
  streaming.stopSending();
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 10000 });
  streaming.startKeepAlive();
  streaming.startSending();
}

// Node runs every timer a tick covers with the clock already at the tick's end, so
// the mocked clock moves one send interval at a time.
function advance(t, ms) {
  for (let left = ms; left > 0; left -= 100) t.mock.timers.tick(Math.min(left, 100));
}

// Hands over audio as a live capture does, 100 ms at a time on the mocked clock.
function capture(t, streaming, ms, fill = 0) {
  for (let captured = 0; captured < ms; captured += 100) {
    streaming.sendAudio(pcm(100, fill));
    t.mock.timers.tick(100);
  }
}

// The server has everything the client sent once it answers the client's ping.
async function received(streaming, session) {
  streaming.ws.ping();
  await once(streaming.ws, "pong");
  return session.chunks;
}

// Lets a stop that was just answered run on, so a test can see it has not ended.
const settled = () => new Promise(setImmediate);

test("the socket URL asks for 24 kHz PCM, VAD commits and word timestamps", () => {
  const streaming = new ElevenLabsStreaming();
  streaming.sampleRate = 24000;
  const url = new URL(
    streaming.buildWebSocketUrl({
      language: "auto",
      keyterms: ["OpenWhispr", "bad <tag>", "Kubernetes", "openwhispr"],
    })
  );

  assert.equal(
    `${url.origin}${url.pathname}`,
    "wss://api.elevenlabs.io/v1/speech-to-text/realtime"
  );
  assert.equal(url.searchParams.get("model_id"), "scribe_v3_live");
  assert.equal(url.searchParams.get("audio_format"), "pcm_24000");
  assert.equal(url.searchParams.get("commit_strategy"), "vad");
  assert.equal(url.searchParams.get("vad_silence_threshold_secs"), "0.8");
  assert.equal(url.searchParams.get("include_timestamps"), "true");
  assert.equal(url.searchParams.has("language_code"), false, "auto detection sends no language");
  assert.deepEqual(url.searchParams.getAll("keyterms"), ["OpenWhispr", "Kubernetes"]);
  assert.equal(url.toString().includes("xi-api-key"), false, "the key never rides in the URL");

  const pinned = new URL(streaming.buildWebSocketUrl({ language: "bg" }));
  assert.equal(pinned.searchParams.get("language_code"), "bg");

  const routed = new URL(streaming.buildWebSocketUrl({ model: "scribe_v2_realtime" }));
  assert.equal(
    routed.searchParams.get("model_id"),
    "scribe_v2_realtime",
    "the route's model is the one sent"
  );

  // The realtime endpoint takes 50 keyterms of at most 20 characters each.
  const many = new URL(
    streaming.buildWebSocketUrl({
      keyterms: [
        ...Array.from({ length: 110 }, (_, i) => `overlong-keyterm-value-${i}`),
        "y".repeat(20),
        ...Array.from({ length: 300 }, (_, i) => `t${i}`),
      ],
    })
  );
  const sent = many.searchParams.getAll("keyterms");
  assert.equal(sent.length, 50);
  assert.equal(sent[0], "y".repeat(20), "a 21-character term is left out, a 20-character one kept");
});

test("audio held during the handshake reaches the server first, as base64 chunks", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const frames = [1, 2, 3, 4].map((value) => Buffer.alloc(FRAME_BYTES, value));

    const connected = streaming.connect({ apiKey: "xi-key", sampleRate: 24000 });
    streaming.sendAudio(frames[0]);
    await once(streaming.ws, "open");
    streaming.sendAudio(frames[1]);
    await connected;
    mockClock(t, streaming);
    streaming.sendAudio(frames[2]);
    streaming.sendAudio(frames[3]);
    t.mock.timers.tick(100);

    const session = sessions[0];
    assert.equal(session.request.headers["xi-api-key"], "xi-key");
    const chunks = await received(streaming, session);
    assert.equal(chunks.length, 1, "they leave together on the first tick");
    const [chunk] = chunks;
    assert.equal(chunk.message_type, "input_audio_chunk");
    assert.equal(chunk.commit, false);
    assert.equal(chunk.sample_rate, 24000);
    assert.deepEqual(audioOf(chunk), Buffer.concat(frames));
    assert.equal(streaming.audioBytesSent, 4 * FRAME_BYTES);
  });
});

test("a timestamped commit is one final segment, timed from its first word", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const partials = [];
    const finals = [];
    streaming.onPartialTranscript = (text) => partials.push(text);
    streaming.onFinalTranscript = (text, timestamp) => finals.push({ text, timestamp });

    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const startedAt = streaming.sessionStartedAt;
    await deliver(
      streaming,
      sessions[0],
      partial("hello"),
      {
        message_type: "committed_transcript_with_timestamps",
        text: " Hello there. ",
        words: [
          { text: " ", start: 0.1, end: 0.2, type: "spacing" },
          { text: "Hello", start: 1.5, end: 1.8, type: "word" },
        ],
      },
      // Its plain twin, which must not add a second segment.
      committed("Hello there."),
      {
        message_type: "committed_transcript_with_timestamps",
        text: "Second.",
        words: [{ text: "Second.", start: 4, end: 4.5, type: "word" }],
      }
    );
    t.mock.timers.tick(PLAIN_COMMIT_GRACE_MS);

    assert.deepEqual(partials, ["hello"]);
    assert.deepEqual(
      finals.map((f) => f.text),
      ["Hello there.", "Hello there. Second."]
    );
    assert.equal(finals[0].timestamp, startedAt + 1500);
    assert.equal(finals[1].timestamp, startedAt + 4000);
    assert.deepEqual(streaming.completedSegments, ["Hello there.", "Second."]);
  });
});

test("a plain commit stands in when no timestamped one follows", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const finals = [];
    streaming.onFinalTranscript = (text) => finals.push(text);

    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    await deliver(streaming, sessions[0], committed("Only plain."));
    t.mock.timers.tick(PLAIN_COMMIT_GRACE_MS - 1);
    assert.deepEqual(finals, [], "it waits for a timestamped twin first");
    t.mock.timers.tick(1);
    assert.deepEqual(finals, ["Only plain."]);
  });
});

test("stopping commits the words heard since the last commit and waits for them", async () => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const finals = [];
    streaming.onFinalTranscript = (text) => finals.push(text);

    await streaming.connect({ apiKey: "k" });
    const session = sessions[0];
    answerStop(session, () => send(session, timed("trailing words", 0.5)));
    await deliver(streaming, session, partial("trailing"));

    const result = await streaming.disconnect();
    const commit = session.chunks.find((chunk) => chunk.commit);
    assert.ok(commit, "a final commit was sent");
    assert.deepEqual(finals, ["trailing words"]);
    assert.equal(result.text, "trailing words");
    assert.equal(streaming.isConnected, false);
  });
});

test("stopping with nothing uncommitted closes without a commit", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const closed = once(sessions[0].socket, "close");
    // Nothing moves the mocked clock, so a stop that waited for a transcript would not return.
    await streaming.disconnect();
    await closed;
    assert.equal(
      sessions[0].chunks.some((chunk) => chunk.commit),
      false
    );
  });
});

test("stopping commits audio the server has shown no words for yet", async () => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const finals = [];
    streaming.onFinalTranscript = (text) => finals.push(text);

    await streaming.connect({ apiKey: "k" });
    const session = sessions[0];
    answerStop(session, () => send(session, timed("last words", 0.1)));
    // Spoken just before the stop: no partial has come back for it.
    streaming.sendAudio(Buffer.alloc(FRAME_BYTES, 1));

    const result = await streaming.disconnect();
    assert.ok(
      session.chunks.some((chunk) => chunk.commit),
      "a final commit was sent"
    );
    assert.deepEqual(finals, ["last words"]);
    assert.equal(result.text, "last words");
  });
});

test("a final commit for quiet audio that is never answered holds the stop only to its deadline", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    streaming.sendAudio(Buffer.alloc(FRAME_BYTES));
    t.mock.timers.tick(100); // sent, so the stop has no backlog to add to its deadline

    const stopped = streaming.disconnect();
    advance(t, 1999);
    await settled();
    assert.equal(streaming.isConnected, true);
    assert.ok((await received(streaming, sessions[0])).some((chunk) => chunk.commit));
    t.mock.timers.tick(1);
    assert.equal((await stopped).text, "");
  });
});

test("a stop that asks for no commit closes at once and delivers nothing more", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const finals = [];
    let ended = 0;
    streaming.onFinalTranscript = (text) => finals.push(text);
    streaming.onSessionEnd = () => ended++;

    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    streaming.sendAudio(Buffer.alloc(FRAME_BYTES, 1));
    await deliver(streaming, session, partial("half a sen"), committed("Waiting for its twin."));

    const closed = once(session.socket, "close");
    // Nothing moves the mocked clock, so a stop that waited for a transcript would not return.
    await streaming.disconnect({ commit: false });
    await closed;
    t.mock.timers.tick(PLAIN_COMMIT_GRACE_MS);
    assert.equal(
      session.chunks.some((chunk) => chunk.commit),
      false
    );
    assert.deepEqual(finals, []);
    assert.equal(ended, 0);
    assert.equal(streaming.isConnected, false);
  });
});

test("Scribe's silence marker is not a segment", async () => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const finals = [];
    streaming.onFinalTranscript = (text) => finals.push(text);

    await streaming.connect({ apiKey: "k" });
    await deliver(streaming, sessions[0], {
      message_type: "committed_transcript_with_timestamps",
      text: "[pause]",
      words: [],
    });
    assert.deepEqual(finals, []);
    assert.deepEqual(streaming.completedSegments, []);
  });
});

for (const [status, code, messageKey] of [
  [401, "PROVIDER_AUTH_FAILED", "providerErrors.authFailed"],
  [403, "PROVIDER_ACCESS_DENIED", "providerErrors.accessDenied"],
  [429, "PROVIDER_RATE_LIMITED", "hooks.audioRecording.errorDescriptions.providerRateLimited"],
  [503, "PROVIDER_UNAVAILABLE", "providerErrors.unavailable"],
]) {
  test(`a handshake answered ${status} fails the start as the classified ${code}`, async () => {
    await withScribeServer(
      async ({ streaming }) => {
        await assert.rejects(streaming.connect({ apiKey: "made-up" }), (error) => {
          assert.equal(error.code, code);
          assert.equal(error.messageKey, messageKey);
          assert.equal(error.status, status);
          return true;
        });
        assert.equal(streaming.isConnected, false);
      },
      { refuse: status }
    );
  });
}

test("an auth_error before the session starts rejects the start", async () => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const connected = streaming.connect({ apiKey: "k" });
    await once(streaming.ws, "open");
    sessions[0].startSession = false;
    send(sessions[0], { message_type: "auth_error", error: "Invalid API key" });
    await assert.rejects(connected, (error) => error.code === "PROVIDER_AUTH_FAILED");
  });
});

for (const [type, code, messageKey] of [
  ["auth_error", "PROVIDER_AUTH_FAILED", "providerErrors.authFailed"],
  ["quota_exceeded", "PROVIDER_QUOTA_EXHAUSTED", "providerErrors.quotaExhausted"],
  ["invalid_request", "PROVIDER_BAD_REQUEST", "providerErrors.badRequest"],
]) {
  test(`${type} mid-session ends the meeting once, as the classified ${code}`, async () => {
    await withScribeServer(async ({ streaming, sessions }) => {
      const errors = [];
      const lost = [];
      streaming.onError = (error) => errors.push(error);
      streaming.onConnectionLost = (error) => lost.push(error);

      await streaming.connect({ apiKey: "k" });
      await deliver(streaming, sessions[0], {
        message_type: type,
        error: "the server's own wording",
      });
      const closed = once(streaming.ws, "close");
      sessions[0].socket.close(1008);
      await closed;

      assert.equal(errors.length, 0);
      assert.equal(lost.length, 1, "the close that follows is not a second loss");
      const [error] = lost;
      assert.equal(error.code, code);
      assert.equal(error.messageKey, messageKey);
      assert.deepEqual(error.messageParams, { provider: "ElevenLabs" });
      assert.equal(error.fatal, true, "the meeting must not retry it");
      assert.equal(error.message.includes("the server's own wording"), false);
    });
  });
}

test("unaccepted_terms mid-session ends the meeting once, and says which terms to accept", async () => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const lost = [];
    streaming.onConnectionLost = (error) => lost.push(error);

    await streaming.connect({ apiKey: "k" });
    await deliver(streaming, sessions[0], {
      message_type: "unaccepted_terms",
      error: "the server's own wording",
    });
    const closed = once(streaming.ws, "close");
    sessions[0].socket.close(1008);
    await closed;

    assert.equal(lost.length, 1, "the close that follows is not a second loss");
    const [error] = lost;
    assert.equal(error.code, "PROVIDER_ACCESS_DENIED");
    // The renderer shows a classified error's shared sentence, which names no terms.
    assert.equal(error.messageKey, undefined);
    assert.equal(
      error.message,
      "Accept ElevenLabs' speech-to-text terms in your ElevenLabs account first."
    );
    assert.equal(error.fatal, true, "the meeting must not retry it");
  });
});

test("a dropped socket reports a lost connection; advisory errors are ignored", async () => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const errors = [];
    const lost = [];
    streaming.onError = (error) => errors.push(error);
    streaming.onConnectionLost = (error) => lost.push(error);

    await streaming.connect({ apiKey: "k" });
    await deliver(
      streaming,
      sessions[0],
      { message_type: "insufficient_audio_activity", error: "quiet" },
      { message_type: "rate_limited", error: "slow down" }
    );
    assert.equal(lost.length, 0, "the loss is the dropped socket's, not theirs");
    const closed = once(streaming.ws, "close");
    sessions[0].socket.close(1011);
    await closed;

    assert.equal(errors.length, 0, "transient and advisory errors raise nothing themselves");
    assert.equal(lost.length, 1);
  });
});

test("a socket error mid-session is one lost connection, and the close behind it adds nothing", async () => {
  await withScribeServer(async ({ streaming }) => {
    const errors = [];
    const lost = [];
    streaming.onError = (error) => errors.push(error);
    streaming.onConnectionLost = (error) => lost.push(error);

    await streaming.connect({ apiKey: "k" });
    const socket = streaming.ws;
    socket.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    await once(socket, "close");

    assert.equal(errors.length, 0);
    assert.equal(lost.length, 1);
    assert.equal(lost[0].code, "PROVIDER_UNREACHABLE");
  });
});

test("the session time limit asks the meeting to renew the session", async () => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const expired = [];
    let lost = 0;
    streaming.onSessionExpired = (info) => expired.push(info);
    streaming.onConnectionLost = () => lost++;
    await streaming.connect({ apiKey: "k" });
    await deliver(streaming, sessions[0], {
      message_type: "session_time_limit_exceeded",
      error: "limit",
    });
    assert.deepEqual(expired, [{ proactive: false }]);
    assert.equal(streaming.isConnected, false, "audio from now on is kept for the new session");
    assert.equal(streaming.sendAudio(Buffer.alloc(FRAME_BYTES)), false);
    const closed = once(streaming.ws, "close");
    sessions[0].socket.close(1000);
    await closed;
    assert.equal(lost, 0);
  });
});

test("words after a pause filled by keep-alive silence are timed from when audio resumed", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const finals = [];
    streaming.onFinalTranscript = (text, timestamp) => finals.push(timestamp);

    await streaming.connect({ apiKey: "k", sampleRate: 24000 });
    mockClock(t, streaming);
    streaming.sendAudio(pcm(1000));
    const startedAt = streaming.sessionStartedAt;
    advance(t, 5000);
    assert.equal(streaming.streamMs, 1000, "the socket has not been idle for 5 s yet");
    advance(t, 7000);
    assert.equal(streaming.streamMs, 1450, "a commit's silence, then a keep-alive's");
    const resumedAt = Date.now();
    streaming.sendAudio(pcm(1000));

    await deliver(
      streaming,
      sessions[0],
      {
        message_type: "committed_transcript_with_timestamps",
        text: "Before.",
        words: [{ text: "Before.", start: 0.5, end: 0.8, type: "word" }],
      },
      {
        message_type: "committed_transcript_with_timestamps",
        text: "After.",
        words: [{ text: "After.", start: 1.95, end: 2.25, type: "word" }],
      }
    );

    assert.equal(finals[0], startedAt + 500);
    assert.equal(finals[1], resumedAt + 500, "timed from the resumed audio");
  });
});

test("stopping waits past a VAD commit already in flight for the words after it", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const finals = [];
    streaming.onFinalTranscript = (text) => finals.push(text);

    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    await deliver(streaming, session, partial("first"));

    const stopped = streaming.disconnect();
    assert.ok((await received(streaming, session)).some((chunk) => chunk.commit));
    // The VAD commit for the earlier words answers first, then the newer words'
    // partial, then the final commit's own transcript.
    await deliver(
      streaming,
      session,
      {
        message_type: "committed_transcript_with_timestamps",
        text: "first part",
        words: [{ text: "first", start: 0.1, end: 0.3, type: "word" }],
      },
      partial("second")
    );
    t.mock.timers.tick(150);
    await settled();
    assert.equal(streaming.isConnected, true, "the stop is still waiting");
    await deliver(streaming, session, timed("second part", 1), ...EMPTY_COMMIT, ...EMPTY_COMMIT);

    const result = await stopped;
    assert.deepEqual(finals, ["first part", "first part second part"]);
    assert.equal(result.text, "first part second part");
  });
});

test("stopping gives a plain commit the chance to be replaced by its timestamped twin", async () => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const finals = [];
    streaming.onFinalTranscript = (text, timestamp) => finals.push({ text, timestamp });

    await streaming.connect({ apiKey: "k" });
    const startedAt = streaming.sessionStartedAt;
    await deliver(streaming, sessions[0], committed("Last words."));
    const stopped = streaming.disconnect();
    send(sessions[0], {
      message_type: "committed_transcript_with_timestamps",
      text: "Last words.",
      words: [{ text: "Last", start: 2, end: 2.2, type: "word" }],
    });
    const result = await stopped;

    assert.deepEqual(finals, [{ text: "Last words.", timestamp: startedAt + 2000 }]);
    assert.equal(result.text, "Last words.");
  });
});

test("a stop while the session is still opening rejects the start", async () => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const connected = streaming.connect({ apiKey: "k" });
    await once(streaming.ws, "open");
    sessions[0].startSession = false;
    await streaming.disconnect();
    await assert.rejects(connected, /stopped before it started/);
  });
});

test("a start the server never answers fails after 30 s, as the classified PROVIDER_TIMEOUT", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    // Mocked before the start, so the start's own timeout runs on the mocked clock.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let failure = null;
    streaming.connect({ apiKey: "k" }).catch((error) => {
      failure = error;
    });
    await once(streaming.ws, "open");
    sessions[0].startSession = false;

    t.mock.timers.tick(29999);
    await settled();
    assert.equal(failure, null, "the start is still waiting");
    t.mock.timers.tick(1);
    await settled();
    assert.equal(failure.code, "PROVIDER_TIMEOUT");
    assert.equal(failure.messageKey, "providerErrors.timeout");
    assert.equal(streaming.ws, null, "the socket it opened is let go");
  });
});

test("a socket closed before the session starts fails the start as the provider being unavailable", async () => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const connected = streaming.connect({ apiKey: "k" });
    await once(streaming.ws, "open");
    sessions[0].startSession = false;
    sessions[0].socket.close(1011);
    await assert.rejects(connected, (error) => {
      assert.equal(error.code, "PROVIDER_UNAVAILABLE");
      assert.equal(error.messageKey, "providerErrors.unavailable");
      return true;
    });
  });
});

test("a client with no start in flight takes no audio", () => {
  const streaming = new ElevenLabsStreaming();
  assert.equal(streaming.sendAudio(Buffer.alloc(FRAME_BYTES)), false);
  streaming.beginConnecting();
  streaming.cleanup();
  assert.equal(streaming.sendAudio(Buffer.alloc(FRAME_BYTES)), false);
});

test("audio held during the handshake is capped at three seconds", () => {
  const streaming = new ElevenLabsStreaming();
  streaming.beginConnecting();

  // Five seconds of 50 ms frames at 24 kHz: the first three seconds are 60 frames.
  const held = Array.from({ length: 100 }, () => streaming.sendAudio(Buffer.alloc(FRAME_BYTES)));

  assert.deepEqual(held, [...Array(60).fill(true), ...Array(40).fill(false)]);
});

test("events from a socket this start replaced leave the start alone", () => {
  const streaming = new ElevenLabsStreaming();
  const staleSocket = new EventEmitter();
  streaming.attachSocketHandlers(staleSocket);
  streaming.beginConnecting();
  streaming.sendAudio(Buffer.alloc(FRAME_BYTES));

  // A session a stale event did start would leave its timers running.
  try {
    staleSocket.emit("message", Buffer.from(JSON.stringify({ message_type: "session_started" })));
    staleSocket.emit("error", new Error("read ECONNRESET"));
    staleSocket.emit("close", 1000, Buffer.alloc(0));

    assert.equal(streaming.isConnected, false, "a stale session_started started the session");
    assert.equal(streaming.preSessionBufferSize, FRAME_BYTES, "a stale end wiped the held audio");
    assert.equal(streaming.sendAudio(Buffer.alloc(FRAME_BYTES)), true, "the start stopped holding");
  } finally {
    streaming.cleanup();
  }
});

test("a stop before the socket exists drops the audio the start was holding", async () => {
  const streaming = new ElevenLabsStreaming();
  streaming.beginConnecting();
  streaming.sendAudio(Buffer.alloc(FRAME_BYTES));

  await streaming.disconnect();

  assert.equal(
    streaming.sendAudio(Buffer.alloc(FRAME_BYTES)),
    false,
    "a stopped client held audio"
  );
  assert.equal(streaming.preSessionBufferSize, 0);
});

test("a delayed timestamped copy cannot consume the next utterance at Stop", async () => {
  await withScribeServer(async ({ streaming, sessions }) => {
    await streaming.connect({ apiKey: "k" });
    const session = sessions[0];
    const first = { text: "First.", message_type: "committed_transcript" };
    send(session, first);
    await once(streaming.ws, "message");
    streaming.sendAudio(Buffer.alloc(FRAME_BYTES, 1));
    await deliver(streaming, session, partial("Last"), {
      ...first,
      message_type: "committed_transcript_with_timestamps",
    });
    answerStop(session, () => send(session, timed("Last words.")));
    assert.equal((await streaming.disconnect()).text, "First. Last words.");
  });
});

test("Stop before a partial waits past an earlier VAD commit", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    streaming.sendAudio(Buffer.alloc(FRAME_BYTES, 1));
    const session = sessions[0];

    const stopped = streaming.disconnect();
    assert.ok((await received(streaming, session)).some((chunk) => chunk.commit));
    await deliver(streaming, session, timed("Earlier."));
    t.mock.timers.tick(60);
    await settled();
    assert.equal(streaming.isConnected, true, "the stop is still waiting");
    await deliver(
      streaming,
      session,
      partial("Later"),
      timed("Later."),
      ...EMPTY_COMMIT,
      ...EMPTY_COMMIT
    );
    assert.equal((await stopped).text, "Earlier. Later.");
  });
});

test("plain commits survive late twins, repeated phrases and a lost socket", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    const stable = { message_type: "committed_transcript", text: "Yes." };
    await deliver(streaming, session, stable);
    t.mock.timers.tick(PLAIN_COMMIT_GRACE_MS);
    await deliver(streaming, session, {
      ...stable,
      message_type: "committed_transcript_with_timestamps",
    });
    assert.deepEqual(streaming.completedSegments, ["Yes."], "the late twin adds no row");
    send(session, stable);
    send(session, { ...stable, text: "End." });
    const lost = new Promise((resolve) => {
      streaming.onConnectionLost = resolve;
    });
    session.socket.close(1011);
    await lost;
    assert.deepEqual(streaming.completedSegments, ["Yes.", "Yes.", "End."]);
  });
});

test("a silence revision clears the live partial", () => {
  const streaming = new ElevenLabsStreaming();
  const partials = [];
  streaming.onPartialTranscript = (text) => partials.push(text);
  const receive = (message_type, text) =>
    streaming.handleMessage(JSON.stringify({ message_type, text }));
  receive("partial_transcript", "Maybe");
  receive("committed_transcript", "[pause]");
  receive("committed_transcript_with_timestamps", "[pause]");
  assert.equal(partials.at(-1), "", "a final silence clears the preceding partial");
  receive("partial_transcript", "[pause]");
  assert.equal(partials.at(-1), "");
  assert.equal(partials.includes("[pause]"), false);
});

test(
  "a plain fallback stays on the audio timeline before the next timed utterance",
  { timeout: 10000 },
  async (t) => {
    await withScribeServer(async ({ streaming, sessions }) => {
      await streaming.connect({ apiKey: "k" });
      mockClock(t, streaming);
      const nextFinal = () =>
        new Promise((resolve) => {
          streaming.onFinalTranscript = (_text, timestamp) =>
            resolve({ text: streaming.completedSegments.at(-1), timestamp });
        });
      const capturedAt = 10000;
      streaming.sendAudio(Buffer.alloc(4800), capturedAt);
      const fallback = nextFinal();
      await deliver(streaming, sessions[0], committed("First."));
      t.mock.timers.tick(PLAIN_COMMIT_GRACE_MS);
      const first = await fallback;
      const timed = nextFinal();
      streaming.sendAudio(Buffer.alloc(4800), capturedAt + 100);
      send(sessions[0], { message_type: "committed_transcript_with_timestamps", text: "First." });
      send(sessions[0], {
        message_type: "committed_transcript_with_timestamps",
        text: "Second.",
        words: [{ type: "word", start: 0.1 }],
      });
      const second = await timed;
      assert.deepEqual([first.text, second.text], ["First.", "Second."]);
      assert.ok(first.timestamp >= capturedAt && first.timestamp < capturedAt + 100);
      assert.equal(second.timestamp, capturedAt + 100);
    });
  }
);

test(
  "later word times distinguish a repeated phrase from a late timestamped twin",
  { timeout: 10000 },
  async (t) => {
    await withScribeServer(async ({ streaming, sessions }) => {
      await streaming.connect({ apiKey: "k" });
      mockClock(t, streaming);
      const timestamps = [];
      const capturedAt = 20000;
      const stable = { message_type: "committed_transcript", text: "Yes." };
      const fallback = new Promise((resolve) => {
        streaming.onFinalTranscript = (_text, timestamp) => {
          timestamps.push(timestamp);
          resolve();
        };
      });
      streaming.sendAudio(Buffer.alloc(4800), capturedAt);
      t.mock.timers.tick(100);
      await deliver(streaming, sessions[0], stable);
      t.mock.timers.tick(PLAIN_COMMIT_GRACE_MS);
      await fallback;
      streaming.sendAudio(Buffer.alloc(4800), capturedAt + 100);
      t.mock.timers.tick(100);
      send(sessions[0], { message_type: "partial_transcript", text: "Yes" });
      await once(streaming.ws, "message");
      const timed = { ...stable, message_type: "committed_transcript_with_timestamps" };
      send(sessions[0], { ...timed, words: [{ type: "word", start: 0.1 }] });
      await once(streaming.ws, "message");
      assert.deepEqual(streaming.completedSegments, ["Yes.", "Yes."]);
      assert.equal(timestamps[1], capturedAt + 100);
      send(sessions[0], { ...timed, words: [{ type: "word", start: 0.04 }] });
      await once(streaming.ws, "message");
      assert.equal(timestamps.length, 2, "the actual late twin still adds no row");
    });
  }
);

test(
  "Stop keeps the original deadline when an earlier VAD commit arrives",
  { timeout: 10000 },
  async (t) => {
    await withScribeServer(async ({ streaming, sessions }) => {
      await streaming.connect({ apiKey: "k" });
      t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
      const session = sessions[0];
      streaming.sendAudio(Buffer.alloc(4800, 1));
      await deliver(streaming, session, { message_type: "partial_transcript", text: "Earlier" });
      streaming.sendAudio(Buffer.alloc(4800, 2));
      const stopped = streaming.disconnect();
      await deliver(streaming, session, { message_type: "committed_transcript", text: "Earlier." });
      await deliver(streaming, session, {
        message_type: "committed_transcript_with_timestamps",
        text: "Earlier.",
      });
      t.mock.timers.tick(1000);
      await new Promise(setImmediate);
      assert.equal(
        streaming.isConnected,
        true,
        "the earlier response did not acknowledge the trailing audio"
      );
      await deliver(streaming, session, { message_type: "partial_transcript", text: "Later" });
      await deliver(streaming, session, { message_type: "committed_transcript", text: "Later." });
      await deliver(streaming, session, {
        message_type: "committed_transcript_with_timestamps",
        text: "Later.",
      });
      t.mock.timers.tick(1100);
      assert.deepEqual(await stopped, { text: "Earlier. Later." });
    });
  }
);

for (const reverseTwinArrives of [false, true]) {
  const order = reverseTwinArrives ? "with a late plain twin" : "without a plain twin";
  test(
    `a plain-only repeat after a new spoken partial survives a timestamp-first result ${order}`,
    { timeout: 10000 },
    async (t) => {
      await withScribeServer(async ({ streaming, sessions }) => {
        await streaming.connect({ apiKey: "k" });
        t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10000 });
        const session = sessions[0];
        const phrase = { text: "Yes." };
        streaming.sendAudio(Buffer.alloc(4800, 1));
        await deliver(streaming, session, {
          ...phrase,
          message_type: "committed_transcript_with_timestamps",
          words: [{ start: 0.01 }],
        });
        streaming.sendAudio(Buffer.alloc(4800, 2));
        await deliver(streaming, session, { message_type: "partial_transcript", text: "Yes" });
        if (reverseTwinArrives) {
          await deliver(streaming, session, { ...phrase, message_type: "committed_transcript" });
        }
        const stopped = streaming.disconnect();
        await deliver(streaming, session, { ...phrase, message_type: "committed_transcript" });
        t.mock.timers.tick(1500);
        await new Promise(setImmediate);
        t.mock.timers.tick(2500);
        assert.deepEqual(await stopped, { text: "Yes. Yes." });
      });
    }
  );
}

test("a burst leaves as one message a tick, of a second at most and in order", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    // 33 ms frames, as the meeting's microphone hands them over, each with its own fill.
    const frames = Array.from({ length: 620 }, (_, i) => Buffer.alloc(1600, SPEECH + (i % 100)));
    const connected = streaming.connect({ apiKey: "k" });
    for (const frame of frames.slice(0, 20)) streaming.sendAudio(frame);
    await connected;
    mockClock(t, streaming);
    const session = sessions[0];
    for (const frame of frames.slice(20)) assert.equal(streaming.sendAudio(frame), true);
    assert.equal((await received(streaming, session)).length, 0, "nothing leaves ahead of a tick");
    assert.equal(
      streaming.audioBytesSent,
      620 * 1600,
      "the meeting reads audio as sent once the client has taken it"
    );

    // 20.67 s of audio: twenty full seconds and the rest.
    for (let tick = 1; tick <= 21; tick++) {
      t.mock.timers.tick(100);
      assert.equal((await received(streaming, session)).length, tick);
    }
    t.mock.timers.tick(100);
    const chunks = await received(streaming, session);
    assert.equal(chunks.length, 21);
    assert.ok(chunks.every((chunk) => !chunk.commit && audioOf(chunk).length <= 48000));
    assert.deepEqual(Buffer.concat(chunks.map(audioOf)), Buffer.concat(frames));
  });
});

test("the first pause after 20 s is committed, in a message of its own that carries silence", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    capture(t, streaming, 19700, SPEECH);
    capture(t, streaming, 200); // a pause, but before 20 s
    capture(t, streaming, 600, SPEECH); // past 20 s, but no pause
    assert.equal(
      (await received(streaming, session)).some((chunk) => chunk.commit),
      false
    );

    capture(t, streaming, 200);
    t.mock.timers.tick(100);
    const chunks = await received(streaming, session);
    assert.deepEqual(
      chunks.filter((chunk) => chunk.commit),
      [chunks.at(-1)]
    );
    assert.deepEqual(audioOf(chunks.at(-1)), pcm(350), "never a bare commit");
    assert.equal(
      Buffer.concat(chunks.slice(0, -1).map(audioOf)).length,
      pcm(20700).length,
      "behind all the audio up to the pause"
    );
  });
});

test("a silent stream is committed every 20 s", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    for (let second = 0; second < 60; second++) {
      streaming.sendAudio(pcm(1000));
      advance(t, 1000);
    }
    const committedAfter = [];
    let seconds = 0;
    for (const chunk of await received(streaming, sessions[0])) {
      if (chunk.commit) committedAfter.push(seconds);
      else seconds += audioOf(chunk).length / 48000;
    }
    assert.deepEqual(committedAfter, [20, 40, 60]);
  });
});

test("a muted microphone's silence is never left out, and is committed every 20 s", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    // No commit is answered, so each one holds two seconds of the silence behind it.
    capture(t, streaming, 60000);
    t.mock.timers.tick(100);
    const chunks = await received(streaming, sessions[0]);
    assert.equal(chunks.filter((chunk) => chunk.commit).length, 3);
    assert.equal(
      Buffer.concat(chunks.filter((chunk) => !chunk.commit).map(audioOf)).length,
      pcm(60000).length
    );
  });
});

// A steady sample at this RMS, as a pcm() fill.
const level = (rms) => {
  const sample = Buffer.alloc(2);
  sample.writeInt16LE(Math.round(rms * 32768));
  return sample;
};

// Each stream's speech is quieter than dictation's 0.012, but above its own pause level.
for (const [stream, speech, pause] of [
  ["mic", 0.008, 0.004],
  ["system", 0.005, 0.003],
]) {
  test(`a quiet speaker on the ${stream} stream is no pause after 20 s, and quieter audio is`, async (t) => {
    await withScribeServer(async ({ streaming, sessions }) => {
      await streaming.connect({ apiKey: "k", streamLabel: stream });
      mockClock(t, streaming);
      const session = sessions[0];
      capture(t, streaming, 25000, level(speech));
      assert.equal(
        (await received(streaming, session)).some((chunk) => chunk.commit),
        false
      );
      capture(t, streaming, 200, level(pause));
      t.mock.timers.tick(100);
      assert.equal((await received(streaming, session)).at(-1).commit, true);
    });
  });
}

test("a capture gap repaired in one burst of silence queues three seconds of it, and the speech behind it keeps its capture time", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const finals = [];
    streaming.onFinalTranscript = (_text, timestamp) => finals.push(timestamp);
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    // A minute's gap as the meeting fills it: 100 ms of silence at a time, all at once.
    const capturedAt = 500000;
    for (let ms = 0; ms < 60000; ms += 100) {
      assert.equal(streaming.sendAudio(pcm(100), capturedAt + ms), true);
    }
    streaming.sendAudio(pcm(500, SPEECH), capturedAt + 60000);
    assert.equal(
      streaming.audioBytesSent,
      pcm(60500).length,
      "the meeting reads audio as sent once the client has taken it"
    );

    // The speech is a message of its own, behind the four that hold the silence.
    advance(t, 500);
    const sent = Buffer.concat((await received(streaming, session)).map(audioOf));
    // The silence that found more than 3 s queued ahead of it was the first left out.
    assert.ok(
      sent.equals(Buffer.concat([pcm(3100), pcm(500, SPEECH)])),
      "3.1 s of the silence leaves, and the speech right behind it"
    );
    await deliver(streaming, session, ...wordedCommit("Back.", 3.2));
    assert.deepEqual(finals, [capturedAt + 60100]);
  });
});

test("the 20 s start again at every committed transcript, the server's own too", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    capture(t, streaming, 15000, SPEECH);
    await deliver(streaming, session, ...wordedCommit("The VAD's own final.", 1));
    capture(t, streaming, 5000, SPEECH);
    capture(t, streaming, 500); // a pause past 20 s, but 5 s after that final
    assert.equal(
      (await received(streaming, session)).some((chunk) => chunk.commit),
      false
    );

    capture(t, streaming, 14300, SPEECH);
    capture(t, streaming, 200);
    t.mock.timers.tick(100);
    const chunks = await received(streaming, session);
    assert.deepEqual(
      chunks.filter((chunk) => chunk.commit),
      [chunks.at(-1)]
    );
    assert.equal(
      Buffer.concat(chunks.slice(0, -1).map(audioOf)).length,
      pcm(35000).length,
      "20 s behind the final"
    );
  });
});

test("audio behind a commit waits for the commit's answer, or for 2 s", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    capture(t, streaming, 20000);
    t.mock.timers.tick(100);
    let sent = (await received(streaming, session)).length;
    assert.equal(session.chunks.at(-1).commit, true);

    streaming.sendAudio(pcm(300, SPEECH));
    advance(t, 1000);
    assert.equal((await received(streaming, session)).length, sent, "held behind the commit");
    await deliver(streaming, session, ...EMPTY_COMMIT);
    t.mock.timers.tick(100);
    assert.deepEqual(audioOf((await received(streaming, session)).at(-1)), pcm(300, SPEECH));

    // The next commit, 20 s on, is never answered.
    capture(t, streaming, 19700);
    t.mock.timers.tick(100);
    sent = (await received(streaming, session)).length;
    assert.equal(session.chunks.at(-1).commit, true);
    streaming.sendAudio(pcm(300, SPEECH));
    advance(t, 1900);
    assert.equal((await received(streaming, session)).length, sent, "held for the 2 s");
    t.mock.timers.tick(100);
    assert.deepEqual(audioOf((await received(streaming, session)).at(-1)), pcm(300, SPEECH));
  });
});

test("words behind a pause commit are still timed from when they were captured", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const finals = [];
    streaming.onFinalTranscript = (_text, timestamp) => finals.push(timestamp);
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const startedAt = Date.now();
    capture(t, streaming, 19800, SPEECH);
    capture(t, streaming, 200); // the pause that is committed
    const resumedAt = Date.now();
    capture(t, streaming, 500, SPEECH);
    // On the server's clock the commit's 0.35 s of silence lies between the two.
    await deliver(
      streaming,
      sessions[0],
      ...wordedCommit("Before.", 19.5),
      ...wordedCommit("After.", 20.45)
    );
    assert.deepEqual(finals, [startedAt + 19500, resumedAt + 100]);
  });
});

test("a replay handed over at once keeps its capture times, across a commit inside it", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const finals = [];
    streaming.onFinalTranscript = (_text, timestamp) => finals.push(timestamp);
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    // 25 s captured from 500000 on: speech, one second of pause after 20 s, speech.
    const capturedAt = 500000;
    for (let second = 0; second < 25; second++) {
      streaming.sendAudio(pcm(1000, second === 20 ? 0 : SPEECH), capturedAt + second * 1000);
    }
    advance(t, 2500);
    assert.deepEqual(
      (await received(streaming, sessions[0])).map((chunk) => chunk.commit),
      [...Array(21).fill(false), true],
      "the commit goes out behind the pause, and holds the rest back"
    );
    await deliver(
      streaming,
      sessions[0],
      ...wordedCommit("Before.", 5),
      ...wordedCommit("After.", 21.6)
    );
    assert.deepEqual(finals, [capturedAt + 5000, capturedAt + 21250]);
  });
});

test("a stop sends three commits with silence in each and ends at the second empty answer in a row", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const finals = [];
    streaming.onFinalTranscript = (text, timestamp) => finals.push({ text, timestamp });
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    const startedAt = Date.now();
    capture(t, streaming, 1000, SPEECH);

    const stopped = streaming.disconnect();
    const commits = (await received(streaming, session)).filter((chunk) => chunk.commit);
    assert.equal(commits.length, 3);
    for (const commit of commits) assert.deepEqual(audioOf(commit), pcm(350));

    await deliver(streaming, session, ...wordedCommit("Trailing words.", 0.2), ...EMPTY_COMMIT);
    await settled();
    assert.equal(streaming.isConnected, true, "the VAD sends empty transcripts of its own");
    await deliver(streaming, session, ...EMPTY_COMMIT);
    assert.deepEqual(await stopped, { text: "Trailing words." });
    assert.deepEqual(finals, [{ text: "Trailing words.", timestamp: startedAt + 200 }]);
    assert.equal(Date.now(), startedAt + 1000, "it waited out no deadline");
  });
});

test("a worded partial or final between two empty answers starts a stop's count again", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    capture(t, streaming, 1000, SPEECH);

    const stopped = streaming.disconnect();
    await deliver(streaming, session, ...EMPTY_COMMIT);
    await deliver(streaming, session, partial("Later"));
    await deliver(streaming, session, ...EMPTY_COMMIT);
    await settled();
    assert.equal(streaming.isConnected, true, "a partial with words came between them");
    await deliver(streaming, session, ...wordedCommit("Later.", 0.5), ...EMPTY_COMMIT);
    await settled();
    assert.equal(streaming.isConnected, true, "and then a final");
    await deliver(streaming, session, ...EMPTY_COMMIT);
    assert.deepEqual(await stopped, { text: "Later." });
  });
});

test("a stop counts a commit once, whichever of its two frames arrives first", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const finals = [];
    streaming.onFinalTranscript = (text) => finals.push(text);
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    capture(t, streaming, 1000, SPEECH);

    const stopped = streaming.disconnect();
    // Each pair the other way round from how Scribe was seen to send it.
    await deliver(
      streaming,
      session,
      timed("Trailing words.", 0.2),
      committed("Trailing words."),
      committed(""),
      timed("")
    );
    await settled();
    assert.equal(streaming.isConnected, true, "that was one empty commit, not two");
    await deliver(streaming, session, committed(""));
    assert.deepEqual(await stopped, { text: "Trailing words." });
    assert.deepEqual(finals, ["Trailing words."]);
  });
});

// What Scribe sent behind a stop's commits when the audio had been flushed at once,
// with the ms since the commits: probe runs c5 and c7 of 2026-11-19. The second run
// sent a fourth commit, whose empty answer is left out.
const RELEASE = "Great. What about the mobile release?";
const MONDAY = "It is scheduled for next Monday.";
const RECORDED_STOPS = [
  {
    name: "an empty transcript of the VAD's ahead of two utterances",
    flushedMs: 10800,
    frames: [
      [199, partial("Celia.")],
      [278, timed("")],
      [280, committed("")],
      [487, partial("¿Hola?")],
      [518, partial("Great.")],
      [542, partial("Great.")],
      [572, partial("Great. What about-")],
      [593, partial("Great. What about the")],
      [613, partial("Great. What about the mobile re-")],
      [636, partial("Great. What about the mobile release?")],
      [664, committed(RELEASE)],
      [684, timed(RELEASE, 4.624)],
      [924, partial("It is")],
      [945, partial("It is scheduled")],
      [971, partial("It is scheduled for")],
      [991, partial("It is scheduled for next")],
      [1010, committed(MONDAY)],
      [1033, timed(MONDAY, 9.244)],
      [1052, timed("")],
      [1054, committed("")],
      [1114, timed("")],
      [1117, committed("")],
    ],
    finals: [
      [RELEASE, 4624],
      [MONDAY, 9244],
    ],
  },
  {
    name: "two empty transcripts of the VAD's, partials between them, ahead of an utterance",
    flushedMs: 11300,
    frames: [
      [214, partial("Celia.")],
      [288, timed("")],
      [290, committed("")],
      [578, partial("S")],
      [615, partial("Celery")],
      [770, timed("")],
      [772, committed("")],
      [955, partial("Great.")],
      [969, partial("Great.")],
      [997, partial("Great. What about-")],
      [1015, partial("Great. What about the")],
      [1036, partial("Great. What about the mobile")],
      [1056, committed(RELEASE)],
      [1075, timed(RELEASE, 9.236)],
      [1093, timed("")],
      [1095, committed("")],
      [1136, timed("")],
      [1138, committed("")],
    ],
    finals: [[RELEASE, 9236]],
  },
];

// Empty transcripts behind a flushed backlog may answer its own pauses, so the stop
// reads on to its deadline: 2 s plus 0.15 s for each second flushed.
async function stopBehindBacklog(t, { flushedMs, frames, finals: expected }) {
  await withScribeServer(async ({ streaming, sessions }) => {
    const finals = [];
    streaming.onFinalTranscript = (_text, timestamp) =>
      finals.push([streaming.completedSegments.at(-1), timestamp]);
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const stoppedAt = Date.now();
    streaming.sendAudio(pcm(flushedMs, SPEECH));

    const stopped = streaming.disconnect();
    for (const [at, frame] of frames) {
      t.mock.timers.tick(stoppedAt + at - Date.now());
      await deliver(streaming, sessions[0], frame);
    }
    const deadline = stoppedAt + 2000 + (flushedMs / 1000) * 150;
    advance(t, deadline - 1 - Date.now());
    await settled();
    assert.equal(streaming.isConnected, true, "an empty answer does not end it early");
    t.mock.timers.tick(1);
    assert.deepEqual(await stopped, { text: expected.map(([text]) => text).join(" ") });
    assert.deepEqual(
      finals,
      expected.map(([text, startMs]) => [text, stoppedAt + startMs])
    );
  });
}

for (const recorded of RECORDED_STOPS) {
  test(`a stop behind a backlog keeps every final: ${recorded.name}`, (t) =>
    stopBehindBacklog(t, recorded));
}

// The second recorded stop without the partials that came between its two empty
// transcripts: the stop's own commits answered empty twice would look the same.
test("a stop behind a backlog keeps the words behind two empty transcripts of the VAD's in a row", (t) =>
  stopBehindBacklog(t, {
    flushedMs: 11300,
    frames: [
      [288, timed("")],
      [290, committed("")],
      [770, timed("")],
      [772, committed("")],
      [1036, partial("Great. What about the mobile release?")],
      [1056, committed(RELEASE)],
      [1075, timed(RELEASE, 9.236)],
      [1093, timed("")],
      [1095, committed("")],
      [1136, timed("")],
      [1138, committed("")],
    ],
    finals: [[RELEASE, 9236]],
  }));

test("an unanswered stop ends 2 s after its commits, and 0.15 s later for each second it flushed", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const finals = [];
    streaming.onFinalTranscript = (text) => finals.push(text);
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    streaming.sendAudio(pcm(10000, SPEECH)); // a backlog no tick has sent yet

    const stopped = streaming.disconnect();
    const chunks = await received(streaming, session);
    assert.deepEqual(
      chunks.map((chunk) => [chunk.commit, audioOf(chunk).length]),
      [...Array(10).fill([false, 48000]), ...Array(3).fill([true, 16800])],
      "the backlog leaves at once, a second to a message"
    );
    await deliver(streaming, session, partial("Never committed"));
    advance(t, 3499);
    await settled();
    assert.equal(streaming.isConnected, true);
    t.mock.timers.tick(1);
    assert.deepEqual(await stopped, { text: "Never committed" });
    assert.deepEqual(finals, ["Never committed"], "the open partial is the last final");
  });
});

test("a stop whose commit wait runs out between two reads of the clock still commits and closes", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    capture(t, streaming, 20000);
    t.mock.timers.tick(100);
    assert.equal((await received(streaming, session)).at(-1).commit, true);
    // The pause commit is never answered. The stop comes in the last millisecond of
    // its wait, and the clock moves on after the stop first reads it.
    advance(t, streaming.commitSentAt + 1999 - Date.now());
    const now = Date.now;
    let reads = 0;
    Date.now = () => now() + (reads++ > 0 ? 1 : 0);
    const stopped = streaming.disconnect();
    Date.now = now;

    advance(t, 100);
    await settled();
    assert.deepEqual(
      (await received(streaming, session)).slice(-3).map((chunk) => chunk.commit),
      [true, true, true]
    );
    await deliver(streaming, session, ...EMPTY_COMMIT, ...EMPTY_COMMIT);
    assert.deepEqual(await stopped, { text: "" });
    assert.equal(streaming.ws, null, "the socket is closed");
  });
});

test("a stop that throws still closes its socket", async (t) => {
  await withScribeServer(async ({ streaming }) => {
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    streaming.sendAudio(pcm(300, SPEECH));
    streaming.sendNext = () => {
      throw new Error("send failed");
    };
    await assert.rejects(streaming.disconnect(), /send failed/);
    assert.equal(streaming.ws, null);
    assert.equal(streaming.keepAliveInterval, null, "no keep-alive holds the session open");
    assert.equal(streaming.isDisconnecting, false);
  });
});

test("a stop waits out an unanswered pause commit before it sends what is behind it", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    capture(t, streaming, 20000);
    t.mock.timers.tick(100);
    streaming.sendAudio(pcm(300, SPEECH));
    const sent = (await received(streaming, session)).length;
    assert.equal(session.chunks.at(-1).commit, true);

    const stopped = streaming.disconnect();
    await settled();
    assert.equal((await received(streaming, session)).length, sent);
    await deliver(streaming, session, ...EMPTY_COMMIT);
    const behind = (await received(streaming, session)).slice(sent);
    assert.deepEqual(
      behind.map((chunk) => chunk.commit),
      [false, true, true, true]
    );
    assert.deepEqual(audioOf(behind[0]), pcm(300, SPEECH));
    // An empty transcript of the VAD's comes first. The pause commit's answer is
    // not counted with it, or the two would end the stop ahead of the words.
    await deliver(
      streaming,
      session,
      ...EMPTY_COMMIT,
      ...wordedCommit("Held words.", 20.4),
      ...EMPTY_COMMIT,
      ...EMPTY_COMMIT
    );
    assert.deepEqual(await stopped, { text: "Held words." });
  });
});

test("a stop behind a backlog waits longer for the answer to a pause commit inside it", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    // 30 s no tick has sent yet: speech, one second of pause after 20 s, speech.
    for (let second = 0; second < 30; second++) {
      streaming.sendAudio(pcm(1000, second === 20 ? 0 : SPEECH));
    }

    const stopped = streaming.disconnect();
    const sent = (await received(streaming, session)).length;
    assert.equal(session.chunks.at(-1).commit, true);
    // Live audio waits 2 s for a commit's answer. Behind this much it takes longer.
    advance(t, 2100);
    await settled();
    assert.equal((await received(streaming, session)).length, sent, "held behind the commit");
    await deliver(streaming, session, ...wordedCommit("Before.", 5));
    const committedAt = Date.now();
    assert.deepEqual(
      (await received(streaming, session)).slice(sent).map((chunk) => chunk.commit),
      [...Array(9).fill(false), true, true, true]
    );
    await deliver(
      streaming,
      session,
      ...wordedCommit("After.", 21.6),
      ...EMPTY_COMMIT,
      ...EMPTY_COMMIT
    );
    // 30.35 s flushed, the pause commit's silence included: a deadline 6.55 s on.
    advance(t, committedAt + 6500 - Date.now());
    await settled();
    assert.equal(streaming.isConnected, true, "a backlog's stop reads on to its deadline");
    advance(t, 100);
    assert.deepEqual(await stopped, { text: "Before. After." });
  });
});

test("a stop ends at once when the socket closes, with the open partial", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    let lost = 0;
    streaming.onConnectionLost = () => lost++;
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    capture(t, streaming, 1000, SPEECH);
    await deliver(streaming, session, partial("Cut off"));

    const stoppedAt = Date.now();
    const stopped = streaming.disconnect();
    session.socket.close(1011);
    assert.deepEqual(await stopped, { text: "Cut off" });
    assert.equal(Date.now(), stoppedAt);
    assert.equal(lost, 0, "a stop under way is not a lost connection");
  });
});

test("a stop that asks for no commit drops the audio still queued", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    streaming.sendAudio(pcm(1000, SPEECH));

    const closed = once(session.socket, "close");
    await streaming.disconnect({ commit: false });
    await closed;
    assert.deepEqual(session.chunks, []);
  });
});

test("the first keep-alive of a capture gap commits what was said before it", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const finals = [];
    streaming.onFinalTranscript = (text, timestamp) => finals.push({ text, timestamp });
    const shape = (chunks) => chunks.map((chunk) => [chunk.commit, audioOf(chunk).length]);
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    advance(t, 6000);
    assert.deepEqual(
      shape(await received(streaming, session)),
      [[false, 4800]],
      "a socket that has sent no audio has nothing to commit"
    );

    const spokenAt = Date.now();
    capture(t, streaming, 1000, SPEECH);
    advance(t, 6000);
    assert.deepEqual(shape(await received(streaming, session)).at(-1), [true, 16800]);
    await deliver(streaming, session, ...wordedCommit("Before the gap.", 0.3));
    assert.deepEqual(finals, [{ text: "Before the gap.", timestamp: spokenAt + 200 }]);

    advance(t, 11000);
    assert.deepEqual(
      shape(await received(streaming, session)).slice(-2),
      [
        [false, 4800],
        [false, 4800],
      ],
      "from then on the keep-alive is plain silence"
    );
  });
});

test("audio handed over just before a keep-alive is due leaves with no commit behind it", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    // A capture gap: one keep-alive after 5 s, and the next due at 10 s.
    advance(t, 9900);
    capture(t, streaming, 300, SPEECH);
    assert.deepEqual(
      (await received(streaming, sessions[0])).map((chunk) => [
        chunk.commit,
        audioOf(chunk).length,
      ]),
      Array(4).fill([false, 4800]),
      "the keep-alive's silence, then the audio as it was handed over"
    );
  });
});

for (const [name, end, report] of [
  ["a dropped socket", (session) => session.socket.close(1011), "lost"],
  [
    // Text that is not UTF-8: the client's socket errors before it closes.
    "a broken frame",
    (session) => session.socket.send(Buffer.from([0xff, 0xfe]), { binary: false }),
    "lost",
  ],
  [
    "a fatal error frame",
    (session) => send(session, { message_type: "quota_exceeded", error: "Quota exceeded" }),
    "lost",
  ],
  [
    "the session time limit",
    (session) => send(session, { message_type: "session_time_limit_exceeded", error: "limit" }),
    "expired",
  ],
]) {
  test(`${name} makes the open partial a final before it is reported`, async (t) => {
    await withScribeServer(async ({ streaming, sessions }) => {
      const events = [];
      streaming.onFinalTranscript = (text) => events.push(text);
      const reported = new Promise((resolve) => {
        streaming.onConnectionLost = () => resolve(events.push("lost"));
        streaming.onSessionExpired = () => resolve(events.push("expired"));
      });
      await streaming.connect({ apiKey: "k" });
      mockClock(t, streaming);
      await deliver(streaming, sessions[0], partial("half a sen"));
      end(sessions[0]);
      await reported;
      assert.deepEqual(events, ["half a sen", report]);
      assert.deepEqual(streaming.completedSegments, ["half a sen"]);
    });
  });
}

for (const [name, frame] of [
  ["a fatal error frame", { message_type: "quota_exceeded", error: "Quota exceeded" }],
  ["the session time limit", { message_type: "session_time_limit_exceeded", error: "limit" }],
]) {
  test(`a partial that trails ${name} does not make the open partial a final again`, async () => {
    await withScribeServer(async ({ streaming, sessions }) => {
      const finals = [];
      streaming.onFinalTranscript = (text) => finals.push(text);
      await streaming.connect({ apiKey: "k" });
      await deliver(
        streaming,
        sessions[0],
        partial("book the flights"),
        frame,
        partial("book the flights and confirm")
      );
      const closed = once(streaming.ws, "close");
      sessions[0].socket.close(1000);
      await closed;
      assert.deepEqual(finals, ["book the flights"]);
    });
  });
}

for (const [name, end] of [
  ["a dropped socket", (session) => session.socket.close(1011)],
  [
    "a stop the server never answers",
    (_session, streaming, t) => {
      const stopped = streaming.disconnect();
      advance(t, 2000);
      return stopped;
    },
  ],
]) {
  test(`the final ${name} makes of the open partial is timed from where its first partial arrived`, async (t) => {
    await withScribeServer(async ({ streaming, sessions }) => {
      const final = new Promise((resolve) => {
        streaming.onFinalTranscript = (text, timestamp) => resolve({ text, timestamp });
      });
      await streaming.connect({ apiKey: "k" });
      mockClock(t, streaming);
      const session = sessions[0];
      const startedAt = Date.now();
      capture(t, streaming, 1000, SPEECH);
      await deliver(streaming, session, partial("Cut"));
      capture(t, streaming, 2000, SPEECH);
      await deliver(streaming, session, partial("Cut off"));
      await end(session, streaming, t);
      // Not at the last sample sent, two seconds on, nor behind a stop's own commits.
      assert.deepEqual(await final, { text: "Cut off", timestamp: startedAt + 1000 });
    });
  });
}

test("audio still queued when the socket drops is handed over once, with its capture times and no commit's silence", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const lost = new Promise((resolve) => {
      streaming.onConnectionLost = resolve;
    });
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    // 25 s handed over at once, each second with its own fill: the pause after 20 s
    // puts a commit in the queue.
    const handedOver = Array.from({ length: 25 }, (_, second) => ({
      buffer: pcm(1000, second === 20 ? 0 : SPEECH + second),
      capturedAt: 500000 + second * 1000,
    }));
    for (const { buffer, capturedAt } of handedOver) streaming.sendAudio(buffer, capturedAt);
    advance(t, 300);
    sessions[0].socket.close(1011);
    await lost;

    const queued = handedOver.slice(3);
    const unsent = streaming.takeUnsentAudio();
    assert.deepEqual(
      unsent.map(({ capturedAt }) => capturedAt),
      queued.map(({ capturedAt }) => capturedAt)
    );
    assert.ok(unsent.every(({ buffer }, index) => buffer.equals(queued[index].buffer)));
    assert.equal(streaming.takeUnsentAudio().length, 0);
  });
});

test("audio held behind an unanswered commit when the socket drops is handed over from when it was captured", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const lost = new Promise((resolve) => {
      streaming.onConnectionLost = resolve;
    });
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    capture(t, streaming, 20000);
    t.mock.timers.tick(100);
    assert.equal((await received(streaming, sessions[0])).at(-1).commit, true);
    // A microphone hands its audio over as it captures it, with no capture time.
    const heldFrom = Date.now();
    capture(t, streaming, 1500, SPEECH);
    sessions[0].socket.close(1011);
    await lost;

    const unsent = streaming.takeUnsentAudio();
    assert.deepEqual(
      unsent.map(({ capturedAt }) => capturedAt),
      [heldFrom, heldFrom + 1000]
    );
    assert.ok(Buffer.concat(unsent.map(({ buffer }) => buffer)).equals(pcm(1500, SPEECH)));
  });
});

test("audio the client never sent keeps its capture time on either side of silence it left out", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const lost = new Promise((resolve) => {
      streaming.onConnectionLost = resolve;
    });
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    // A sentence, a minute of silence handed over at once, and the next sentence.
    const capturedAt = 500000;
    streaming.sendAudio(pcm(1000, SPEECH), capturedAt);
    for (let ms = 1000; ms < 61000; ms += 100) streaming.sendAudio(pcm(100), capturedAt + ms);
    streaming.sendAudio(pcm(500, SPEECH), capturedAt + 61000);
    sessions[0].socket.close(1011);
    await lost;

    const unsent = streaming.takeUnsentAudio();
    assert.deepEqual(
      unsent.map((audio) => audio.capturedAt),
      [0, 1000, 2000, 3000, 61000].map((ms) => capturedAt + ms)
    );
    assert.ok(unsent.at(-1).buffer.equals(pcm(500, SPEECH)));
  });
});

test("audio captured well after the audio before it is timed from its own capture", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const finals = [];
    streaming.onFinalTranscript = (_text, timestamp) => finals.push(timestamp);
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    // What a dropped session never sent is replayed with holes where it left silence
    // out. A replayed microphone's capture times only jitter.
    streaming.sendAudio(pcm(1000, SPEECH), 500000);
    streaming.sendAudio(pcm(1000, SPEECH), 501400);
    streaming.sendAudio(pcm(1000, SPEECH), 504000);
    advance(t, 300);

    await deliver(streaming, sessions[0], ...wordedCommit("Jitter.", 1.5));
    await deliver(streaming, sessions[0], ...wordedCommit("A hole.", 2.5));
    assert.deepEqual(finals, [501500, 504500]);
  });
});

test("the session time limit leaves the audio still queued for the session that replaces it", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const session = sessions[0];
    streaming.sendAudio(pcm(3000, SPEECH), 500000);
    t.mock.timers.tick(100);
    await deliver(streaming, session, {
      message_type: "session_time_limit_exceeded",
      error: "limit",
    });

    const unsent = streaming.takeUnsentAudio();
    assert.deepEqual(
      unsent.map(({ capturedAt }) => capturedAt),
      [501000, 502000]
    );
    assert.ok(Buffer.concat(unsent.map(({ buffer }) => buffer)).equals(pcm(2000, SPEECH)));
    advance(t, 6000);
    assert.equal((await received(streaming, session)).length, 1, "nothing more leaves the socket");
  });
});

test("a socket that cannot be opened fails the start as the provider being unreachable", async () => {
  // The fixture closes its server on the way out, which leaves its client nothing to reach.
  let stranded;
  await withScribeServer(async ({ streaming }) => {
    stranded = streaming;
  });
  await assert.rejects(stranded.connect({ apiKey: "k" }), (error) => {
    assert.equal(error.code, "PROVIDER_UNREACHABLE");
    assert.equal(error.messageKey, "providerErrors.unreachable");
    assert.equal(error.cause.code, "ECONNREFUSED");
    return true;
  });
});

test("a queue_overflow is named in the log and ends the session as a loss the meeting retries", async (t) => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const logged = t.mock.method(debugLogger, "error", () => {});
    let errors = 0;
    streaming.onError = () => errors++;
    const lost = new Promise((resolve) => {
      streaming.onConnectionLost = resolve;
    });
    await streaming.connect({ apiKey: "k" });
    mockClock(t, streaming);
    const detail = "Session terminated: audio data is being sent too frequently.";
    send(sessions[0], { message_type: "queue_overflow", error: detail });
    sessions[0].socket.close(1000, "queue_overflow");

    assert.equal((await lost).fatal, undefined);
    assert.equal(errors, 0);
    assert.deepEqual(
      logged.mock.calls.map((call) => call.arguments[1]),
      [{ type: "queue_overflow", detail }]
    );
  });
});

test("a queue_overflow that refuses a start is the provider being unavailable", async () => {
  await withScribeServer(async ({ streaming, sessions }) => {
    const connected = streaming.connect({ apiKey: "k" });
    await once(streaming.ws, "open");
    sessions[0].startSession = false;
    send(sessions[0], { message_type: "queue_overflow", error: "Session terminated." });
    await assert.rejects(connected, (error) => {
      assert.equal(error.code, "PROVIDER_UNAVAILABLE");
      assert.equal(error.messageKey, "providerErrors.unavailable");
      return true;
    });
  });
});

test("the ElevenLabs realtime canary passes only when the session starts and cleans up either way", async () => {
  const { probeElevenLabsRealtime } =
    await import("../../scripts/lib/elevenlabs-realtime-probe.mjs");
  await withScribeServer(async ({ streaming, sessions }) => {
    assert.deepEqual(await probeElevenLabsRealtime("test-key", streaming), { ok: true });
    const { headers, url } = sessions[0].request;
    assert.equal(headers["xi-api-key"], "test-key");
    assert.deepEqual(new URL(url, "ws://loopback").searchParams.getAll("keyterms"), ["OpenWhispr"]);
    assert.equal(streaming.ws, null, "the session it started is let go");
  });
  await withScribeServer(
    async ({ streaming }) => {
      await assert.rejects(
        probeElevenLabsRealtime("test-key", streaming),
        (error) => error.code === "PROVIDER_AUTH_FAILED"
      );
      assert.equal(streaming.ws, null);
    },
    { refuse: 401 }
  );
});
