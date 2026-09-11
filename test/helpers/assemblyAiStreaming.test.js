const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocketServer } = require("ws");

const AssemblyAiStreaming = require("../../src/helpers/assemblyAiStreaming");
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
// binary frame the server receives.
async function withBeginServer(run, { onAudioFrame } = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const connections = [];
  server.on("connection", (socket, request) => {
    connections.push(request.url);
    socket.on("message", (data, isBinary) => {
      if (isBinary) onAudioFrame?.(data);
    });
    socket.send(JSON.stringify({ type: "Begin", id: "test-session" }));
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
// must fail the run rather than hang it.
async function collectFrames({ chunkBytes, chunkCount }, assertFrames) {
  const frames = [];
  let receivedBytes = 0;
  const allReceived = deferred();
  const expectedBytes = chunkBytes * chunkCount;

  await withBeginServer(
    async (url, connections) => {
      const streaming = new AssemblyAiStreaming();
      // The real builder is what pins the session's sample rate: do not stub it.
      dialLoopback(streaming, url);

      try {
        await streaming.connect({
          token: "byok-key",
          mode: "byok",
          sampleRate: MEETING_SAMPLE_RATE,
        });
        for (let i = 0; i < chunkCount; i++) streaming.sendAudio(Buffer.alloc(chunkBytes));
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
        assertFrames(frames);
      } finally {
        streaming.cleanupAll();
      }
    },
    {
      onAudioFrame: (data) => {
        frames.push(data.length);
        receivedBytes += data.length;
        if (receivedBytes >= expectedBytes) allReceived.resolve();
      },
    }
  );
}

test("audio frames respect AssemblyAI's 50 ms floor at the meeting sample rate", async () => {
  // 480 bytes is the smallest meeting-aec-helper can hand over (one 10 ms frame).
  await collectFrames({ chunkBytes: 480, chunkCount: 20 }, (frames) => {
    assert.ok(frames.length > 0, "no audio reached the server");
    for (const bytes of frames) {
      assert.ok(
        frameDurationMs(bytes) >= 50,
        `sent a ${frameDurationMs(bytes).toFixed(1)} ms frame; AssemblyAI's floor is 50 ms`
      );
    }
  });
});

test("a coalesced system-audio read is split under AssemblyAI's 1000 ms ceiling", async () => {
  // A stalled main process gets one 64 KB pipe read off the system-audio helper:
  // 1365 ms at 24 kHz, which AssemblyAI rejects like an undersized frame.
  await collectFrames({ chunkBytes: 65536, chunkCount: 1 }, (frames) => {
    assert.ok(frames.length > 1, "a 1365 ms read must be split, not sent whole");
    for (const bytes of frames) {
      assert.ok(
        frameDurationMs(bytes) >= 50 && frameDurationMs(bytes) <= 1000,
        `sent a ${frameDurationMs(bytes).toFixed(1)} ms frame; AssemblyAI accepts 50-1000 ms`
      );
    }
  });
});
