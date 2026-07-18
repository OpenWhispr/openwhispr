const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocketServer } = require("ws");

const AssemblyAiStreaming = require("../../src/helpers/assemblyAiStreaming");

const OUTCOME_TIMEOUT_MS = 250;

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

async function withBeginServer(run) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "Begin", id: "test-session" }));
  });

  try {
    await run(`ws://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function capturePromptOutcome(promise) {
  let timeout;
  try {
    return await Promise.race([
      promise.then(
        () => ({ type: "resolved" }),
        (error) => ({ type: "rejected", error })
      ),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ type: "pending" }), OUTCOME_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("warmup rejects when the socket closes before Begin", async () => {
  await withPrematureCloseServer(async (url) => {
    const streaming = new AssemblyAiStreaming();
    streaming.buildWebSocketUrl = () => url;

    const outcome = await capturePromptOutcome(streaming.warmup({ token: "test-token" }));
    streaming.cleanupAll();

    assert.equal(outcome.type, "rejected");
    assert.match(outcome.error.message, /closed.*1008/i);
  });
});

test("connect rejects when the socket closes before Begin", async () => {
  await withPrematureCloseServer(async (url) => {
    const streaming = new AssemblyAiStreaming();
    streaming.buildWebSocketUrl = () => url;

    const outcome = await capturePromptOutcome(streaming.connect({ token: "test-token" }));
    streaming.cleanupAll();

    assert.equal(outcome.type, "rejected");
    assert.match(outcome.error.message, /closed.*1008/i);
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
