const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { WebSocketServer } = require("ws");

const AssemblyAiStreaming = require("../../src/helpers/assemblyAiStreaming");
const { audioRecorder } = require("./harness/audioRecorder");
const { deferred } = require("./harness/deferred");

async function withPrematureCloseServer(run) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    socket.close(1008, "rejected before Begin");
  });

  try {
    await run(`ws://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// `connections` collects each accepted request URL so a test can count sockets
// and read the query the client actually sent. `onAudioFrame` reports each
// binary frame the server receives. `beginDelayMs` holds Begin back, leaving
// the socket open before the session has begun.
async function withBeginServer(run, { onAudioFrame, beginDelayMs = 0 } = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const connections = [];
  server.on("connection", (socket, request) => {
    connections.push(request.url);
    socket.on("message", (data, isBinary) => {
      if (isBinary) onAudioFrame?.(data);
    });
    const begin = () => socket.send(JSON.stringify({ type: "Begin", id: "test-session" }));
    if (beginDelayMs) setTimeout(begin, beginDelayMs);
    else begin();
  });

  try {
    await run(`ws://127.0.0.1:${server.address().port}`, connections);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Keeps the real query string (speech_model, token) while dialing the loopback server.
function dialLoopback(streaming, url) {
  const buildRealUrl = streaming.buildWebSocketUrl.bind(streaming);
  streaming.buildWebSocketUrl = (options) =>
    buildRealUrl(options).replace("wss://streaming.assemblyai.com/v3/ws", url);
}

test("warmup rejects when the socket closes before Begin", async () => {
  await withPrematureCloseServer(async (url) => {
    const streaming = new AssemblyAiStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await assert.rejects(() => streaming.warmup({ token: "test-token" }), /closed.*1008/i);
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("connect rejects when the socket closes before Begin", async () => {
  await withPrematureCloseServer(async (url) => {
    const streaming = new AssemblyAiStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await assert.rejects(() => streaming.connect({ token: "test-token" }), /closed.*1008/i);
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("warmup resolves when the server sends Begin", async () => {
  await withBeginServer(async (url) => {
    const streaming = new AssemblyAiStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await streaming.warmup({ token: "test-token" });

      assert.equal(streaming.hasWarmConnection(), true);
      assert.equal(streaming.warmSessionId, "test-session");
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("connect resolves when the server sends Begin", async () => {
  await withBeginServer(async (url) => {
    const streaming = new AssemblyAiStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await streaming.connect({ token: "test-token" });

      assert.equal(streaming.isConnected, true);
      assert.equal(streaming.sessionId, "test-session");
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("a warm connection is reused only within the same credential mode", async () => {
  await withBeginServer(async (url, connections) => {
    const streaming = new AssemblyAiStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await streaming.warmup({ token: "managed-token", mode: "openwhispr" });
      assert.equal(streaming.getCachedToken(), "managed-token");

      // The main-process singleton serves BYOK and managed dictation alike: a
      // BYOK session must neither ride the managed socket nor see its token.
      await streaming.connect({ token: "byok-key", mode: "byok" });

      assert.equal(connections.length, 2, "the managed warm socket was not reused");
      assert.equal(streaming.hasWarmConnection(), false);
      assert.equal(streaming.getCachedToken(), null, "the managed token was dropped");
      assert.equal(streaming.mode, "byok");
    } finally {
      streaming.cleanupAll();
    }
  });

  await withBeginServer(async (url, connections) => {
    const streaming = new AssemblyAiStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await streaming.warmup({ token: "managed-token", mode: "openwhispr" });
      await streaming.connect({ token: "managed-token", mode: "openwhispr" });

      assert.equal(connections.length, 1, "same-mode start rides the warm socket");
      assert.equal(streaming.isConnected, true);
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("a warm connection opened for another speech model is not reused", async () => {
  await withBeginServer(async (url, connections) => {
    const streaming = new AssemblyAiStreaming();
    dialLoopback(streaming, url);

    try {
      await streaming.warmup({
        token: "byok-key",
        mode: "byok",
        model: "universal-streaming-english",
      });
      // The server pins speech_model at Begin; reusing this socket would keep the
      // warm model for the whole session and hide the downgrade from the user.
      await streaming.connect({ token: "byok-key", mode: "byok", model: "universal-3-5-pro" });

      assert.equal(connections.length, 2);
      assert.match(connections[0], /speech_model=universal-streaming-english/);
      assert.match(connections[1], /speech_model=universal-3-5-pro/);
      assert.equal(streaming.requestedModel, "universal-3-5-pro");
    } finally {
      streaming.cleanupAll();
    }
  });

  await withBeginServer(async (url, connections) => {
    const streaming = new AssemblyAiStreaming();
    dialLoopback(streaming, url);

    try {
      await streaming.warmup({ token: "byok-key", mode: "byok", model: "universal-3-5-pro" });
      await streaming.connect({ token: "byok-key", mode: "byok", model: "universal-3-5-pro" });

      assert.equal(connections.length, 1, "same model rides the warm socket");
    } finally {
      streaming.cleanupAll();
    }
  });
});

// Note Recording's MEETING_STREAM_SAMPLE_RATE (#2140).
const MEETING_SAMPLE_RATE = 24000;
const frameDurationMs = (bytes) => (bytes / 2 / MEETING_SAMPLE_RATE) * 1000;

// node:test has no default timeout, so the wait is bounded here: withheld audio
// must fail the run rather than hang it. Each chunk is filled with its 1-based
// index, so `audio` (every byte received, in order) shows loss and reordering.
async function collectFrames(chunks, assertFrames, { whileConnecting = false } = {}) {
  const frames = [];
  const received = [];
  let receivedBytes = 0;
  const allReceived = deferred();
  const expectedBytes = chunks.reduce((total, bytes) => total + bytes, 0);

  await withBeginServer(
    async (url, connections) => {
      const streaming = new AssemblyAiStreaming();
      // The real builder is what pins the session's sample rate: do not stub it.
      dialLoopback(streaming, url);
      const sendChunks = () =>
        chunks.forEach((bytes, index) => streaming.sendAudio(Buffer.alloc(bytes, index + 1)));

      try {
        const connected = streaming.connect({
          token: "byok-key",
          mode: "byok",
          sampleRate: MEETING_SAMPLE_RATE,
        });
        // The socket cannot open within this tick, so these arrive while it connects.
        if (whileConnecting) sendChunks();
        await connected;
        if (!whileConnecting) sendChunks();
        await Promise.race([
          allReceived.promise,
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(`only ${receivedBytes} of ${expectedBytes} bytes reached the server`)
                ),
              2000
            ).unref()
          ),
        ]);

        assert.match(
          connections[0],
          /sample_rate=24000/,
          "the session must open at the meeting rate for the frame maths to mean anything"
        );
        assertFrames(frames, Buffer.concat(received));
      } finally {
        streaming.cleanupAll();
      }
    },
    {
      onAudioFrame: (data) => {
        frames.push(data.length);
        received.push(data);
        receivedBytes += data.length;
        if (receivedBytes >= expectedBytes) allReceived.resolve();
      },
    }
  );
}

test("audio frames respect AssemblyAI's 50 ms floor at the meeting sample rate", async () => {
  // 480 bytes is the smallest meeting-aec-helper can hand over (one 10 ms frame).
  await collectFrames(Array(20).fill(480), (frames) => {
    assert.ok(frames.length > 0, "no audio reached the server");
    for (const bytes of frames) {
      assert.ok(
        frameDurationMs(bytes) >= 50,
        `sent a ${frameDurationMs(bytes).toFixed(1)} ms frame; AssemblyAI's floor is 50 ms`
      );
    }
  });
});

test("a coalesced system-audio read is split inside AssemblyAI's frame window", async () => {
  // A stalled main process gets one 64 KB pipe read off the system-audio helper:
  // 1365 ms at 24 kHz, which AssemblyAI rejects like an undersized frame. The
  // slices target the documented 250 ms ceiling, not the 1000 ms hard limit.
  await collectFrames([65536], (frames) => {
    assert.ok(frames.length > 1, "a 1365 ms read must be split, not sent whole");
    for (const bytes of frames) {
      assert.ok(
        frameDurationMs(bytes) >= 50 && frameDurationMs(bytes) <= 250,
        `sent a ${frameDurationMs(bytes).toFixed(1)} ms frame; AssemblyAI documents 50-250 ms`
      );
    }
  });
});

test("a sub-floor remainder is carried into the next frame, not dropped", async () => {
  // 50000 B leaves 2000 B after the slices — under the 2400 B floor at 24 kHz, so
  // it can only go out once the next chunk lifts it over. Without the carry it is
  // silently discarded and 2000 B of speech never reaches the transcript, which
  // collectFrames catches as bytes that never arrive. Asserting the tail rather
  // than the whole shape keeps this independent of MAX_FRAME_MS.
  await collectFrames([50000, 2400], (frames) => {
    assert.equal(frames.at(-1), 4400, "the 2000 B tail must ride out on the next frame");
  });
});

test("audio sent while the socket connects arrives in order, in 50-250 ms frames", async () => {
  // 300 ms of 10 ms chunks, all offered while the socket is still connecting —
  // the opening words of a cold start. Sent one by one they would be 10 ms
  // frames; sent as one they would be a 300 ms frame. AssemblyAI rejects both.
  const chunks = Array(30).fill(480);
  await collectFrames(
    chunks,
    (frames, audio) => {
      assert.deepEqual(
        audio,
        Buffer.concat(chunks.map((bytes, index) => Buffer.alloc(bytes, index + 1)))
      );
      for (const bytes of frames) {
        assert.ok(
          frameDurationMs(bytes) >= 50 && frameDurationMs(bytes) <= 250,
          `sent a ${frameDurationMs(bytes).toFixed(1)} ms frame; AssemblyAI documents 50-250 ms`
        );
      }
    },
    { whileConnecting: true }
  );
});

test("audio held while connecting goes out ahead of audio sent once the socket opens", async () => {
  // Begin is held back, so the socket opens before the session begins. What
  // arrives in that gap must not overtake the opening words held before it.
  const frames = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((value) => Buffer.alloc(1600, value));
  const audio = audioRecorder();

  await withBeginServer(
    async (url) => {
      const streaming = new AssemblyAiStreaming();
      streaming.buildWebSocketUrl = () => url;

      try {
        const connected = streaming.connect({ token: "test-token" });
        for (const frame of frames.slice(0, 3)) streaming.sendAudio(frame);
        await once(streaming.ws, "open");
        for (const frame of frames.slice(3, 6)) streaming.sendAudio(frame);
        await connected;
        for (const frame of frames.slice(6)) streaming.sendAudio(frame);

        assert.deepEqual(await audio.received(9 * 1600), Buffer.concat(frames));
      } finally {
        streaming.cleanupAll();
      }
    },
    { onAudioFrame: (data) => audio.record(data), beginDelayMs: 100 }
  );
});

test("a client with no start in flight takes no audio", () => {
  const streaming = new AssemblyAiStreaming();
  assert.equal(streaming.sendAudio(Buffer.alloc(1600)), false, "an idle client held audio");

  streaming.beginConnecting();
  streaming.cleanup(); // what a closed or failed socket runs
  assert.equal(streaming.sendAudio(Buffer.alloc(1600)), false, "an ended start held audio");
});

test("a session that has begun drops audio while its socket closes", async () => {
  await withBeginServer(async (url) => {
    const streaming = new AssemblyAiStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await streaming.connect({ token: "test-token" });
      streaming.ws.close(); // CLOSING until the close handshake ends the session

      assert.equal(streaming.sendAudio(Buffer.alloc(1600)), false);
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("audio held during a start is capped at three seconds", () => {
  const streaming = new AssemblyAiStreaming();
  streaming.beginConnecting();

  // Five seconds of 50 ms frames at 16 kHz: the first three seconds are 60 frames.
  const held = Array.from({ length: 100 }, () => streaming.sendAudio(Buffer.alloc(1600)));

  assert.deepEqual(held, [...Array(60).fill(true), ...Array(40).fill(false)]);
});

test("a warm connection opened at another sample rate is not reused", async () => {
  await withBeginServer(async (url, connections) => {
    const streaming = new AssemblyAiStreaming();
    dialLoopback(streaming, url);

    try {
      await streaming.warmup({ token: "byok-key", mode: "byok" });
      // The rate is pinned at open, so riding a 16 kHz warm socket with 24 kHz PCM
      // garbles the transcript silently and re-frames audio against the wrong rate.
      await streaming.connect({
        token: "byok-key",
        mode: "byok",
        sampleRate: MEETING_SAMPLE_RATE,
      });

      assert.equal(connections.length, 2);
      assert.match(connections[0], /sample_rate=16000/);
      assert.match(connections[1], /sample_rate=24000/);
      assert.equal(streaming.sessionSampleRate, MEETING_SAMPLE_RATE);
    } finally {
      streaming.cleanupAll();
    }
  });

  await withBeginServer(async (url, connections) => {
    const streaming = new AssemblyAiStreaming();
    dialLoopback(streaming, url);

    try {
      const options = { token: "byok-key", mode: "byok", sampleRate: MEETING_SAMPLE_RATE };
      await streaming.warmup(options);
      await streaming.connect(options);

      assert.equal(connections.length, 1, "same rate rides the warm socket");
    } finally {
      streaming.cleanupAll();
    }
  });
});
