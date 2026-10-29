const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { WebSocketServer } = require("ws");

const ElevenLabsStreaming = require("../../src/helpers/elevenLabsStreaming");

const FRAME_BYTES = 2400; // one 50 ms frame at 24 kHz

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Loopback Scribe Realtime server. It starts the session a beat after the socket
// opens, so audio sent during the handshake shows up as held, and hands each test
// the socket so it can answer with transcripts and errors.
async function withScribeServer(run, { refuse = null } = {}) {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    ...(refuse ? { verifyClient: (_info, done) => done(false, refuse) } : {}),
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const sessions = [];
  server.on("connection", (socket, request) => {
    const session = { socket, request, chunks: [], startSession: true };
    sessions.push(session);
    socket.on("message", (data) => session.chunks.push(JSON.parse(data.toString())));
    setTimeout(() => {
      if (session.startSession && socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify({
            message_type: "session_started",
            session_id: "s-1",
            config: { model_id: "scribe_v2_realtime" },
          })
        );
      }
    }, 50);
  });

  try {
    await run(`ws://127.0.0.1:${server.address().port}`, sessions);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}

function pointAt(streaming, url) {
  const build = streaming.buildWebSocketUrl.bind(streaming);
  streaming.buildWebSocketUrl = (options) => `${url}?${new URL(build(options)).searchParams}`;
}

const send = (session, message) => session.socket.send(JSON.stringify(message));

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
  assert.equal(url.searchParams.get("model_id"), "scribe_v2_realtime");
  assert.equal(url.searchParams.get("audio_format"), "pcm_24000");
  assert.equal(url.searchParams.get("commit_strategy"), "vad");
  assert.equal(url.searchParams.get("include_timestamps"), "true");
  assert.equal(url.searchParams.has("language_code"), false, "auto detection sends no language");
  assert.deepEqual(url.searchParams.getAll("keyterms"), ["OpenWhispr", "Kubernetes"]);
  assert.equal(url.toString().includes("xi-api-key"), false, "the key never rides in the URL");

  const pinned = new URL(streaming.buildWebSocketUrl({ language: "bg" }));
  assert.equal(pinned.searchParams.get("language_code"), "bg");

  const many = new URL(
    streaming.buildWebSocketUrl({ keyterms: Array.from({ length: 300 }, (_, i) => `t${i}`) })
  );
  assert.equal(many.searchParams.getAll("keyterms").length, 100);
});

test("audio held during the handshake reaches the server first, as base64 chunks", async () => {
  await withScribeServer(async (url, sessions) => {
    const streaming = new ElevenLabsStreaming();
    pointAt(streaming, url);
    const frames = [1, 2, 3, 4].map((value) => Buffer.alloc(FRAME_BYTES, value));

    try {
      const connected = streaming.connect({ apiKey: "xi-key", sampleRate: 24000 });
      streaming.sendAudio(frames[0]);
      await once(streaming.ws, "open");
      streaming.sendAudio(frames[1]);
      await connected;
      streaming.sendAudio(frames[2]);
      streaming.sendAudio(frames[3]);
      await wait(50);

      const session = sessions[0];
      assert.equal(session.request.headers["xi-api-key"], "xi-key");
      assert.equal(session.chunks.length, 4);
      for (const [index, chunk] of session.chunks.entries()) {
        assert.equal(chunk.message_type, "input_audio_chunk");
        assert.equal(chunk.commit, false);
        assert.equal(chunk.sample_rate, 24000);
        assert.deepEqual(Buffer.from(chunk.audio_base_64, "base64"), frames[index]);
      }
      assert.equal(streaming.audioBytesSent, 4 * FRAME_BYTES);
    } finally {
      streaming.cleanup();
    }
  });
});

test("a timestamped commit is one final segment, timed from its first word", async () => {
  await withScribeServer(async (url, sessions) => {
    const streaming = new ElevenLabsStreaming();
    pointAt(streaming, url);
    const partials = [];
    const finals = [];
    streaming.onPartialTranscript = (text) => partials.push(text);
    streaming.onFinalTranscript = (text, timestamp) => finals.push({ text, timestamp });

    try {
      await streaming.connect({ apiKey: "k" });
      const startedAt = streaming.sessionStartedAt;
      const session = sessions[0];
      send(session, { message_type: "partial_transcript", text: "hello" });
      send(session, {
        message_type: "committed_transcript_with_timestamps",
        text: " Hello there. ",
        words: [
          { text: " ", start: 0.1, end: 0.2, type: "spacing" },
          { text: "Hello", start: 1.5, end: 1.8, type: "word" },
        ],
      });
      // Its plain twin, which must not add a second segment.
      send(session, { message_type: "committed_transcript", text: "Hello there." });
      send(session, {
        message_type: "committed_transcript_with_timestamps",
        text: "Second.",
        words: [{ text: "Second.", start: 4, end: 4.5, type: "word" }],
      });
      await wait(1700);

      assert.deepEqual(partials, ["hello"]);
      assert.deepEqual(
        finals.map((f) => f.text),
        ["Hello there.", "Hello there. Second."]
      );
      assert.equal(finals[0].timestamp, startedAt + 1500);
      assert.equal(finals[1].timestamp, startedAt + 4000);
      assert.deepEqual(streaming.completedSegments, ["Hello there.", "Second."]);
    } finally {
      streaming.cleanup();
    }
  });
});

test("a plain commit stands in when no timestamped one follows", async () => {
  await withScribeServer(async (url, sessions) => {
    const streaming = new ElevenLabsStreaming();
    pointAt(streaming, url);
    const finals = [];
    streaming.onFinalTranscript = (text) => finals.push(text);

    try {
      await streaming.connect({ apiKey: "k" });
      send(sessions[0], { message_type: "committed_transcript", text: "Only plain." });
      await wait(200);
      assert.deepEqual(finals, [], "it waits for a timestamped twin first");
      await wait(1500);
      assert.deepEqual(finals, ["Only plain."]);
    } finally {
      streaming.cleanup();
    }
  });
});

test("stopping commits the words heard since the last commit and waits for them", async () => {
  await withScribeServer(async (url, sessions) => {
    const streaming = new ElevenLabsStreaming();
    pointAt(streaming, url);
    const finals = [];
    streaming.onFinalTranscript = (text) => finals.push(text);

    await streaming.connect({ apiKey: "k" });
    const session = sessions[0];
    session.socket.on("message", (data) => {
      if (JSON.parse(data.toString()).commit) {
        send(session, {
          message_type: "committed_transcript_with_timestamps",
          text: "trailing words",
          words: [{ text: "trailing", start: 0.5, end: 0.9, type: "word" }],
        });
      }
    });
    send(session, { message_type: "partial_transcript", text: "trailing" });
    await wait(50);

    const result = await streaming.disconnect();
    const commit = session.chunks.find((chunk) => chunk.commit);
    assert.ok(commit, "a final commit was sent");
    assert.equal(commit.audio_base_64, "");
    assert.deepEqual(finals, ["trailing words"]);
    assert.equal(result.text, "trailing words");
    assert.equal(streaming.isConnected, false);
  });
});

test("stopping with nothing uncommitted closes without a commit", async () => {
  await withScribeServer(async (url, sessions) => {
    const streaming = new ElevenLabsStreaming();
    pointAt(streaming, url);
    await streaming.connect({ apiKey: "k" });
    const started = Date.now();
    await streaming.disconnect();
    await wait(50);
    assert.equal(
      sessions[0].chunks.some((chunk) => chunk.commit),
      false
    );
    assert.ok(Date.now() - started < 1000, "it did not wait for a transcript");
  });
});

test("a refused key fails the start as an auth error", async () => {
  await withScribeServer(
    async (url) => {
      const streaming = new ElevenLabsStreaming();
      pointAt(streaming, url);
      await assert.rejects(
        streaming.connect({ apiKey: "made-up" }),
        (error) => error.code === "PROVIDER_AUTH_FAILED"
      );
      assert.equal(streaming.isConnected, false);
    },
    { refuse: 401 }
  );
});

test("an auth_error before the session starts rejects the start", async () => {
  await withScribeServer(async (url, sessions) => {
    const streaming = new ElevenLabsStreaming();
    pointAt(streaming, url);
    const connected = streaming.connect({ apiKey: "k" });
    await once(streaming.ws, "open");
    await wait(10);
    sessions[0].startSession = false;
    send(sessions[0], { message_type: "auth_error", error: "Invalid API key" });
    await assert.rejects(connected, (error) => error.code === "PROVIDER_AUTH_FAILED");
  });
});

test("a fatal error mid-session ends the meeting once instead of reconnecting", async () => {
  await withScribeServer(async (url, sessions) => {
    const streaming = new ElevenLabsStreaming();
    pointAt(streaming, url);
    const errors = [];
    const lost = [];
    streaming.onError = (error) => errors.push(error);
    streaming.onConnectionLost = (error) => lost.push(error);

    await streaming.connect({ apiKey: "k" });
    send(sessions[0], { message_type: "quota_exceeded", error: "Quota exceeded" });
    await wait(50);
    sessions[0].socket.close(1008);
    await wait(100);

    assert.equal(errors.length, 0);
    assert.equal(lost.length, 1, "the close that follows is not a second loss");
    assert.equal(lost[0].code, "PROVIDER_QUOTA_EXHAUSTED");
    assert.equal(lost[0].fatal, true, "the meeting must not retry it");
  });
});

test("a dropped socket reports a lost connection; advisory errors are ignored", async () => {
  await withScribeServer(async (url, sessions) => {
    const streaming = new ElevenLabsStreaming();
    pointAt(streaming, url);
    const errors = [];
    const lost = [];
    streaming.onError = (error) => errors.push(error);
    streaming.onConnectionLost = (error) => lost.push(error);

    await streaming.connect({ apiKey: "k" });
    send(sessions[0], { message_type: "insufficient_audio_activity", error: "quiet" });
    send(sessions[0], { message_type: "rate_limited", error: "slow down" });
    await wait(50);
    sessions[0].socket.close(1011);
    await wait(100);

    assert.equal(errors.length, 0, "transient and advisory errors raise nothing themselves");
    assert.equal(lost.length, 1);
  });
});

test("the session time limit asks the meeting to renew the session", async () => {
  await withScribeServer(async (url, sessions) => {
    const streaming = new ElevenLabsStreaming();
    pointAt(streaming, url);
    const expired = [];
    let lost = 0;
    streaming.onSessionExpired = (info) => expired.push(info);
    streaming.onConnectionLost = () => lost++;
    try {
      await streaming.connect({ apiKey: "k" });
      send(sessions[0], { message_type: "session_time_limit_exceeded", error: "limit" });
      await wait(50);
      assert.deepEqual(expired, [{ proactive: false }]);
      assert.equal(streaming.isConnected, false, "audio from now on is kept for the new session");
      assert.equal(streaming.sendAudio(Buffer.alloc(FRAME_BYTES)), false);
      sessions[0].socket.close(1000);
      await wait(50);
      assert.equal(lost, 0);
    } finally {
      streaming.cleanup();
    }
  });
});

test("words after a pause filled by keep-alive silence are timed from when audio resumed", async () => {
  await withScribeServer(async (url, sessions) => {
    const streaming = new ElevenLabsStreaming();
    pointAt(streaming, url);
    const finals = [];
    streaming.onFinalTranscript = (text, timestamp) => finals.push(timestamp);

    try {
      await streaming.connect({ apiKey: "k", sampleRate: 24000 });
      const startedAt = streaming.sessionStartedAt;
      streaming.sendAudio(Buffer.alloc(48000)); // 1 s
      streaming.lastSendAt = 0; // the next keep-alive tick sends silence
      await wait(1100);
      assert.equal(streaming.streamMs, 1100);
      const resumedAt = Date.now();
      streaming.sendAudio(Buffer.alloc(48000));

      send(sessions[0], {
        message_type: "committed_transcript_with_timestamps",
        text: "Before.",
        words: [{ text: "Before.", start: 0.5, end: 0.8, type: "word" }],
      });
      send(sessions[0], {
        message_type: "committed_transcript_with_timestamps",
        text: "After.",
        words: [{ text: "After.", start: 1.6, end: 1.9, type: "word" }],
      });
      await wait(50);

      assert.equal(finals[0], startedAt + 500);
      assert.ok(Math.abs(finals[1] - (resumedAt + 500)) < 20, "timed from the resumed audio");
    } finally {
      streaming.cleanup();
    }
  });
});

test("stopping waits past a VAD commit already in flight for the words after it", async () => {
  await withScribeServer(async (url, sessions) => {
    const streaming = new ElevenLabsStreaming();
    pointAt(streaming, url);
    const finals = [];
    streaming.onFinalTranscript = (text) => finals.push(text);

    await streaming.connect({ apiKey: "k" });
    const session = sessions[0];
    session.socket.on("message", (data) => {
      if (!JSON.parse(data.toString()).commit) return;
      // The VAD commit for the earlier words answers first, then the newer words'
      // partial, then the final commit's own transcript.
      send(session, {
        message_type: "committed_transcript_with_timestamps",
        text: "first part",
        words: [{ text: "first", start: 0.1, end: 0.3, type: "word" }],
      });
      send(session, { message_type: "partial_transcript", text: "second" });
      setTimeout(
        () =>
          send(session, {
            message_type: "committed_transcript_with_timestamps",
            text: "second part",
            words: [{ text: "second", start: 1, end: 1.3, type: "word" }],
          }),
        150
      );
    });
    send(session, { message_type: "partial_transcript", text: "first" });
    await wait(50);

    const result = await streaming.disconnect();
    assert.deepEqual(finals, ["first part", "first part second part"]);
    assert.equal(result.text, "first part second part");
  });
});

test("stopping gives a plain commit the chance to be replaced by its timestamped twin", async () => {
  await withScribeServer(async (url, sessions) => {
    const streaming = new ElevenLabsStreaming();
    pointAt(streaming, url);
    const finals = [];
    streaming.onFinalTranscript = (text, timestamp) => finals.push({ text, timestamp });

    await streaming.connect({ apiKey: "k" });
    const startedAt = streaming.sessionStartedAt;
    send(sessions[0], { message_type: "committed_transcript", text: "Last words." });
    await wait(30);
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
  await withScribeServer(async (url, sessions) => {
    const streaming = new ElevenLabsStreaming();
    pointAt(streaming, url);
    const connected = streaming.connect({ apiKey: "k" });
    await once(streaming.ws, "open");
    sessions[0].startSession = false;
    await streaming.disconnect();
    await assert.rejects(connected, /stopped before it started/);
  });
});

test("a client with no start in flight takes no audio", () => {
  const streaming = new ElevenLabsStreaming();
  assert.equal(streaming.sendAudio(Buffer.alloc(FRAME_BYTES)), false);
  streaming.beginConnecting();
  streaming.cleanup();
  assert.equal(streaming.sendAudio(Buffer.alloc(FRAME_BYTES)), false);
});
