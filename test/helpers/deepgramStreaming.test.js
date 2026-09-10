const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocketServer } = require("ws");

const DeepgramStreaming = require("../../src/helpers/deepgramStreaming");

// Loopback Deepgram: warmup resolves on the socket opening, connect on the
// first server message, so every accepted socket answers with Metadata.
async function withMetadataServer(run) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const connections = [];
  server.on("connection", (socket, request) => {
    connections.push(request.url);
    socket.send(JSON.stringify({ type: "Metadata", request_id: `req-${connections.length}` }));
  });

  try {
    await run(`ws://127.0.0.1:${server.address().port}`, connections);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a warm connection is reused only within the same credential mode", async () => {
  await withMetadataServer(async (url, connections) => {
    const streaming = new DeepgramStreaming();
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
      assert.equal(
        streaming.connectionOptions.mode,
        "byok",
        "a liveness reconnect must stay in the session's mode"
      );
    } finally {
      streaming.cleanupAll();
    }
  });

  await withMetadataServer(async (url, connections) => {
    const streaming = new DeepgramStreaming();
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

test("adopting a different mode before a warmup drops the other mode's token", async () => {
  await withMetadataServer(async (url) => {
    const streaming = new DeepgramStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await streaming.warmup({ token: "byok-key", mode: "byok" });
      // ipcHandlers adopts the incoming mode before consulting the token cache
      // for a managed start, so the BYOK key can never be replayed as a token.
      streaming.adoptMode({ mode: "openwhispr" });

      assert.equal(streaming.getCachedToken(), null);
      assert.equal(streaming.hasWarmConnection(), false);
    } finally {
      streaming.cleanupAll();
    }
  });
});
