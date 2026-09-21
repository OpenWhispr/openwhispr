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
  const authHeaders = [];
  server.on("connection", (socket, request) => {
    connections.push(request.url);
    authHeaders.push(request.headers.authorization);
    socket.send(JSON.stringify({ type: "Metadata", request_id: `req-${connections.length}` }));
  });

  try {
    await run(`ws://127.0.0.1:${server.address().port}`, connections, authHeaders);
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

// Keeps the real query string (language, keyterms) while dialing the loopback server.
function dialLoopback(streaming, url) {
  const buildRealUrl = streaming.buildWebSocketUrl.bind(streaming);
  streaming.buildWebSocketUrl = (options) =>
    buildRealUrl(options).replace("wss://api.deepgram.com/v1/listen", url);
}

test("a warm connection opened for another language is not reused", async () => {
  await withMetadataServer(async (url, connections) => {
    const streaming = new DeepgramStreaming();
    dialLoopback(streaming, url);

    try {
      // Dictation warms on the UI language: warmupStreamingConnection() runs at
      // startup and after each transcription, before setTranslationRequested()
      // can say a translation wants the source language instead. The URL pins
      // that language — and with it nova-3 vs nova-2 — for the whole session.
      await streaming.warmup({ token: "byok-key", mode: "byok", language: "en" });
      await streaming.connect({ token: "byok-key", mode: "byok", language: "fr" });

      assert.equal(connections.length, 2, "the English warm socket was reused for French");
      assert.match(connections[0], /language=en/);
      assert.match(connections[1], /language=fr/);
    } finally {
      streaming.cleanupAll();
    }
  });

  await withMetadataServer(async (url, connections) => {
    const streaming = new DeepgramStreaming();
    dialLoopback(streaming, url);

    try {
      const options = { token: "byok-key", mode: "byok", language: "en" };
      await streaming.warmup(options);
      await streaming.connect(options);

      assert.equal(connections.length, 1, "same language rides the warm socket");
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("a warm connection opened for other keyterms is not reused", async () => {
  await withMetadataServer(async (url, connections) => {
    const streaming = new DeepgramStreaming();
    dialLoopback(streaming, url);

    try {
      await streaming.warmup({ token: "byok-key", mode: "byok", keyterms: ["Whispr"] });
      await streaming.connect({ token: "byok-key", mode: "byok", keyterms: ["Whispr", "Qdrant"] });

      assert.equal(connections.length, 2, "a dictionary edit must reach the socket");
      assert.match(connections[1], /keyterm=Qdrant/);
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("a warm connection is reused when the two option sets build the same URL", async () => {
  // buildWebSocketUrl folds "auto" into no language and skips empty keyterms, so
  // the guard has to fold them the same way — otherwise every dictation cold
  // starts and the warm socket stops buying anything.
  await withMetadataServer(async (url, connections) => {
    const streaming = new DeepgramStreaming();
    dialLoopback(streaming, url);

    try {
      await streaming.warmup({ token: "byok-key", mode: "byok", language: "auto" });
      await streaming.connect({ token: "byok-key", mode: "byok", keyterms: [] });

      assert.equal(connections.length, 1, "an identical URL must ride the warm socket");
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

test("a BYOK key authenticates under Deepgram's Token scheme", async () => {
  await withMetadataServer(async (url, connections, authHeaders) => {
    const streaming = new DeepgramStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await streaming.connect({ token: "byok-key", mode: "byok" });

      assert.deepEqual(authHeaders, ["Token byok-key"]);
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("a managed grant token authenticates under the Bearer scheme", async () => {
  await withMetadataServer(async (url, connections, authHeaders) => {
    const streaming = new DeepgramStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await streaming.connect({ token: "grant-token", mode: "openwhispr" });

      assert.deepEqual(authHeaders, ["Bearer grant-token"]);
    } finally {
      streaming.cleanupAll();
    }
  });
});

test("warmup presents the same scheme the session will connect with", async () => {
  await withMetadataServer(async (url, connections, authHeaders) => {
    const streaming = new DeepgramStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await streaming.warmup({ token: "byok-key", mode: "byok" });

      assert.deepEqual(authHeaders, ["Token byok-key"]);
    } finally {
      streaming.cleanupAll();
    }
  });
});

// Runs `schedule` with setTimeout stubbed out and hands back its callback, so a
// timer-gated branch can be exercised at once. Scoped to the one synchronous
// call: mocking setTimeout for any longer deadlocks the ws server's teardown.
function captureScheduledCallback(schedule) {
  const realSetTimeout = global.setTimeout;
  let scheduled = null;
  global.setTimeout = (callback) => {
    scheduled = callback;
    return { unref() {} };
  };
  try {
    schedule();
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.ok(scheduled, "nothing was scheduled");
  return scheduled;
}

test("a re-warm whose options were dropped does not re-authenticate as managed", async () => {
  await withMetadataServer(async (url, connections, authHeaders) => {
    const streaming = new DeepgramStreaming();
    streaming.buildWebSocketUrl = () => url;

    try {
      await streaming.warmup({ token: "byok-key", mode: "byok" });
      assert.deepEqual(authHeaders, ["Token byok-key"]);

      const rewarm = captureScheduledCallback(() => streaming.scheduleRewarm());
      // cleanupWarmConnection() drops the saved options without cancelling the
      // timer, and the cached token outlives them — so the re-warm still has a
      // credential to present, just no longer any record of which kind it is.
      streaming.cleanupWarmConnection();
      await rewarm();

      assert.equal(streaming.mode, "byok", "the re-warm renegotiated the credential mode");
      assert.equal(streaming.warmConnection, null, "a socket was opened without a known mode");
    } finally {
      streaming.cleanupAll();
    }
  });
});

// Its only consumer is the weekly canary, not PR CI: without this, deleting the
// export stays green for a week.
test("the authorization scheme is exported for the canary to reuse", () => {
  assert.equal(DeepgramStreaming.authorizationHeader("byok", "k"), "Token k");
  assert.equal(DeepgramStreaming.authorizationHeader("openwhispr", "k"), "Bearer k");
});
