const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocketServer } = require("ws");

const AssemblyAiStreaming = require("../../src/helpers/assemblyAiStreaming");

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
// and read the query the client actually sent.
async function withBeginServer(run) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const connections = [];
  server.on("connection", (socket, request) => {
    connections.push(request.url);
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
