const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocketServer } = require("ws");

const CortiStreaming = require("../../src/helpers/cortiStreaming");

// Accepts Corti's config handshake: every socket that sends `config` gets
// CONFIG_ACCEPTED with its own session id.
async function withCortiServer(run) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  let sessions = 0;
  server.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString());
      if (message.type === "config") {
        socket.send(JSON.stringify({ type: "CONFIG_ACCEPTED", sessionId: `s${++sessions}` }));
      }
    });
  });

  try {
    await run(`ws://127.0.0.1:${server.address().port}`);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}

const OPTIONS = { token: "t", environment: "eu", tenant: "base" };

test("a session started over a stale one survives the stale socket's close", async () => {
  await withCortiServer(async (url) => {
    const streaming = new CortiStreaming();
    streaming.buildWebSocketUrl = () => url;
    const errors = [];
    streaming.onError = (error) => errors.push(error.message);

    try {
      await streaming.connect(OPTIONS);
      assert.equal(streaming.sessionId, "s1");

      // corti-streaming-start: a start that finds a connected session (the
      // renderer reloaded mid-dictation) drops it, then connects again.
      await streaming.disconnect(false);
      await streaming.connect(OPTIONS);
      assert.equal(streaming.sessionId, "s2");

      // Let the dropped socket's close handshake finish.
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal(streaming.isConnected, true, "the new session must stay connected");
      assert.equal(streaming.sessionId, "s2");
      assert.deepEqual(errors, []);
    } finally {
      await streaming.disconnect(false);
    }
  });
});

test("dropping a session that is still connecting rejects its pending connect", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  // Never accepts the config, so connect() stays pending.
  const opened = new Promise((resolve) => server.once("connection", resolve));

  try {
    const streaming = new CortiStreaming();
    streaming.buildWebSocketUrl = () => `ws://127.0.0.1:${server.address().port}`;
    const connecting = streaming.connect(OPTIONS);
    await opened;

    await streaming.disconnect(false);

    await assert.rejects(connecting);
    assert.equal(streaming.isConnected, false);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});
