const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { Worker } = require("node:worker_threads");
const { WebSocket, WebSocketServer } = require("ws");
const {
  OrukeetStreaming,
  streamingUrl,
  MANAGED_STREAM_OPTIONS,
} = require("../../src/helpers/orukeetStreaming");

async function fixture(t, onMessage, { serverOptions, adapterOptions, onConnection } = {}) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1", ...serverOptions });
  await once(server, "listening");
  const seen = [];
  server.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, "Bearer test-key");
    assert.equal(request.url, "/v1/audio/transcriptions/stream");
    onConnection?.(socket);
    socket.send(
      JSON.stringify({
        type: "ready",
        sample_rate: 16000,
        channels: 1,
        encoding: "pcm_s16le",
        max_seconds: 60,
      })
    );
    socket.on("message", (data, binary) => {
      const event = binary ? Buffer.from(data) : JSON.parse(data.toString());
      seen.push(event);
      onMessage?.(socket, event, seen);
    });
  });
  const adapter = new OrukeetStreaming({ timeoutMs: 300, ...adapterOptions });
  t.after(async () => {
    await adapter.disconnect();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    adapter,
    seen,
    options: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-key" },
  };
}

test("PCM including pre-connect audio precedes commit, and finalization waits for final", async (t) => {
  const { adapter, seen, options } = await fixture(t, (socket, event) => {
    if (event.type === "commit")
      setTimeout(
        () =>
          socket.send(
            JSON.stringify({
              type: "final",
              text: "Full recording.",
              inference_ms: 12,
              server_ms: 14,
            })
          ),
        10
      );
  });
  adapter.beginConnecting();
  adapter.sendAudio(Buffer.from([1, 0]));
  await adapter.connect(options);
  adapter.sendAudio(Buffer.from([2, 0]));
  const pending = adapter.finalize();
  assert.equal(adapter.finalize(), pending);
  const result = await pending;
  assert.equal(result.text, "Full recording.");
  assert.equal(result.audioBytesSent, 4);
  assert.equal(result.inferenceMs, 12);
  assert.deepEqual(seen, [Buffer.from([1, 0]), Buffer.from([2, 0]), { type: "commit" }]);
});

test("capacity retry commits retained audio without uploading it twice", async (t) => {
  let commits = 0;
  const { adapter, seen, options } = await fixture(t, (socket, event) => {
    if (event.type === "commit")
      socket.send(
        JSON.stringify(
          ++commits === 1
            ? { type: "error", code: "capacity", retry_after_ms: 20 }
            : { type: "final", text: "Retried." }
        )
      );
  });
  await adapter.connect(options);
  adapter.sendAudio(Buffer.alloc(640));
  assert.equal((await adapter.finalize()).text, "Retried.");
  assert.equal(seen.filter(Buffer.isBuffer).length, 1);
  assert.equal(commits, 2);
});

test("language hints are advisory and the final language is passed through", async (t) => {
  const { adapter, options } = await fixture(t, (socket, event) => {
    if (Buffer.isBuffer(event)) {
      socket.send(JSON.stringify({ type: "language", language: "ar", language_confidence: 0.8 }));
    } else if (event.type === "commit") {
      socket.send(
        JSON.stringify({
          type: "final",
          text: "Transcript",
          language: "hi",
          language_confidence: 0.97,
          language_audio_seconds: 6,
        })
      );
    }
  });
  const hints = [];
  let finals = 0;
  adapter.onLanguage = (value) => hints.push(value);
  adapter.onFinalTranscript = () => finals++;
  await adapter.connect(options);
  adapter.sendAudio(Buffer.alloc(640));
  const result = await adapter.finalize();
  assert.deepEqual(hints, [{ language: "ar", languageConfidence: 0.8 }]);
  assert.equal(result.language, "hi");
  assert.equal(result.languageConfidence, 0.97);
  assert.equal(result.languageAudioSeconds, 6);
  assert.equal(finals, 1);
});

for (const metadata of [
  { language: null, language_confidence: null },
  { language: "english", language_confidence: 0.9 },
  { language: "en", language_confidence: "0.9" },
  { language: "en", language_confidence: 1.1 },
  { language: "en", language_confidence: -0.1 },
]) {
  test(`invalid or unknown language does not fail transcription: ${JSON.stringify(metadata)}`, async (t) => {
    const { adapter, options } = await fixture(t, (socket, event) => {
      if (event.type === "commit") {
        socket.send(JSON.stringify({ type: "language", ...metadata }));
        socket.send(JSON.stringify({ type: "final", text: "Still works", ...metadata }));
      }
    });
    adapter.onLanguage = () => assert.fail("Invalid hint must not reach consumers");
    await adapter.connect(options);
    adapter.sendAudio(Buffer.alloc(640));
    const result = await adapter.finalize();
    assert.equal(result.text, "Still works");
    assert.equal(result.language, null);
    assert.equal(result.languageConfidence, null);
  });
}

test("cancellation closes without committing audio", async (t) => {
  const { adapter, seen, options } = await fixture(t);
  await adapter.connect(options);
  adapter.sendAudio(Buffer.alloc(640));
  await adapter.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    seen.some((event) => event.type === "commit"),
    false
  );
});

test("server errors reject finalization instead of returning partial success", async (t) => {
  const { adapter, options } = await fixture(t, (socket, event) => {
    if (event.type === "commit")
      socket.send(JSON.stringify({ type: "error", code: "unavailable" }));
  });
  await adapter.connect(options);
  adapter.sendAudio(Buffer.alloc(640));
  await assert.rejects(adapter.finalize(), /unavailable/);
});

test("missing final acknowledgement has a bounded timeout", async (t) => {
  const { adapter, options } = await fixture(t);
  await adapter.connect(options);
  adapter.sendAudio(Buffer.alloc(640));
  const started = performance.now();
  await assert.rejects(adapter.finalize(), /timed out/);
  // Self-hosted streams wait their connect timeout (300 ms here) for a final.
  assert.ok(performance.now() - started < 1000);
});

test("URL normalization retains the selected server and refuses unsafe credential URLs", () => {
  assert.equal(
    streamingUrl("https://example.com/v1/audio/transcriptions"),
    "wss://example.com/v1/audio/transcriptions/stream"
  );
  assert.equal(
    streamingUrl("https://example.com/asr/v1/"),
    "wss://example.com/asr/v1/audio/transcriptions/stream"
  );
  for (const url of [
    "http://example.com",
    "https://key@example.com",
    "https://example.com?key=secret",
  ]) {
    assert.throws(() => streamingUrl(url));
  }
});

test("duplicate finals are delivered exactly once", async (t) => {
  const { adapter, options } = await fixture(t, (socket, event) => {
    if (event.type === "commit") {
      socket.send(JSON.stringify({ type: "final", text: "Once." }));
      socket.send(JSON.stringify({ type: "final", text: "Once." }));
    }
  });
  let finals = 0;
  adapter.onFinalTranscript = () => finals++;
  await adapter.connect(options);
  adapter.sendAudio(Buffer.alloc(640));
  await adapter.finalize();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(finals, 1);
});

test("cancelled adapters cannot reconnect", async (t) => {
  const { adapter, options } = await fixture(t);
  adapter.beginConnecting();
  await adapter.disconnect();
  await assert.rejects(adapter.connect(options), /new Orukeet adapter/);
});

test("early finalization cannot discard queued startup audio", async (t) => {
  const { adapter } = await fixture(t);
  adapter.beginConnecting();
  adapter.sendAudio(Buffer.alloc(640));
  await assert.rejects(adapter.finalize(), /not ready/);
  assert.equal(adapter.pendingBytes, 640);
});

test("oversized capacity backoff cannot overflow the timer into a retry loop", async (t) => {
  let commits = 0;
  const { adapter, options } = await fixture(t, (socket, event) => {
    if (event.type === "commit") {
      commits++;
      socket.send(
        JSON.stringify({ type: "error", code: "capacity", retry_after_ms: Number.MAX_SAFE_INTEGER })
      );
    }
  });
  await adapter.connect(options);
  adapter.sendAudio(Buffer.alloc(640));
  await assert.rejects(adapter.finalize(), /timed out/);
  assert.equal(commits, 1);
});

async function gateway(t, options = {}) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1", ...options });
  await once(server, "listening");
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test("a socket refused before ready rejects connect without raising a stream error", async (t) => {
  // The gateway can refuse the upgrade itself, or accept it and answer with an
  // error instead of `ready` (the per-account cap does either).
  const refusedUpgrade = await gateway(t, { verifyClient: (_info, done) => done(false, 429) });
  const refusedSession = await gateway(t);
  refusedSession.server.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "error", code: "account_limit", message: "Busy" }));
    socket.close();
  });

  for (const { baseUrl } of [refusedUpgrade, refusedSession]) {
    const adapter = new OrukeetStreaming({ timeoutMs: 300 });
    const errors = [];
    adapter.onError = (error) => errors.push(error);
    await assert.rejects(adapter.connect({ baseUrl, apiKey: "test-key" }));
    assert.deepEqual(errors, [], baseUrl);
  }
});

test("a refusal after ready still raises a stream error", async (t) => {
  const { adapter, options } = await fixture(t, (socket) =>
    socket.send(JSON.stringify({ type: "error", code: "account_limit", message: "Busy" }))
  );
  const raised = new Promise((resolve) => {
    adapter.onError = resolve;
  });
  await adapter.connect(options);
  adapter.sendAudio(Buffer.from([1, 0]));
  assert.equal((await raised).message, "Busy");
});

test("a server closing a completed socket raises no stream error", async (t) => {
  // Orukeet closes a finished socket right after its final when the account
  // already holds a warm one.
  const { adapter, options } = await fixture(t, (socket, event) => {
    if (event.type === "commit") {
      socket.send(JSON.stringify({ type: "final", text: "" }));
      socket.close();
    }
  });
  const errors = [];
  adapter.onError = (error) => errors.push(error);
  await adapter.connect(options);
  const closed = once(adapter.ws, "close");
  adapter.sendAudio(Buffer.from([1, 0]));

  assert.equal((await adapter.finalize()).text, "");
  await closed;
  assert.deepEqual(errors, []);
});

test("a failure while the session token is minted raises no stream error", async () => {
  // Main creates the adapter before minting the managed token, so it is
  // connecting before connect() runs; the failed start reports this failure.
  const adapter = new OrukeetStreaming({ timeoutMs: 300 });
  const errors = [];
  adapter.onError = (error) => errors.push(error);
  adapter.beginConnecting();
  adapter.sendAudio(Buffer.alloc(2 * 1024 * 1024 + 2));

  await assert.rejects(
    adapter.connect({ baseUrl: "http://127.0.0.1:9", apiKey: "test-key" }),
    /new Orukeet adapter/
  );
  assert.deepEqual(errors, []);
});

// Answers pings until the test stalls it, like a GPU host whose server process
// wedges while its TCP connection stays open.
async function stallableFixture(t, onMessage, adapterOptions) {
  const control = { answering: true, delayMs: 0, socket: null };
  const setup = await fixture(t, onMessage, {
    serverOptions: { autoPong: false },
    adapterOptions,
    onConnection: (socket) => {
      control.socket = socket;
      socket.on("ping", (data) => {
        if (!control.answering) return;
        if (control.delayMs) setTimeout(() => socket.pong(data), control.delayMs);
        else socket.pong(data);
      });
    },
  });
  return { ...setup, control };
}

test(
  "a stream whose server stops answering pings fails while recording",
  { timeout: 2000 },
  async (t) => {
    const livenessMs = 400;
    const { adapter, options, control } = await stallableFixture(t, undefined, { livenessMs });
    const raised = new Promise((resolve) => {
      adapter.onError = resolve;
    });
    await adapter.connect(options);
    await once(adapter.ws, "pong");
    const closed = once(control.socket, "close");
    control.answering = false;
    const stalledAt = performance.now();
    adapter.sendAudio(Buffer.alloc(640));

    assert.match((await raised).message, /stopped responding/);
    const detectedAfter = performance.now() - stalledAt;
    assert.ok(
      detectedAfter > livenessMs - 20 && detectedAfter < livenessMs * 2,
      `${detectedAfter}`
    );
    await assert.rejects(adapter.finalize(), /stopped responding/);
    // Dropped rather than closed behind unsent audio, so the server sees 1006.
    assert.equal((await closed)[0], 1006);
  }
);

test("a blocked main thread is not judged a stalled server", { timeout: 5000 }, async (t) => {
  const livenessMs = 400;
  const { adapter, options, control } = await stallableFixture(
    t,
    (socket, event) => {
      if (event.type === "commit") socket.send(JSON.stringify({ type: "final", text: "Kept." }));
    },
    { livenessMs }
  );
  const errors = [];
  adapter.onError = (error) => errors.push(error);
  await adapter.connect(options);
  await new Promise((resolve) =>
    adapter.ws.once("pong", () => {
      // The ping sent after the block is answered later than one check
      // interval, but within the liveness window.
      control.delayMs = livenessMs * 0.75;
      const until = performance.now() + livenessMs * 2.5;
      while (performance.now() < until);
      resolve();
    })
  );
  adapter.sendAudio(Buffer.alloc(640));
  await new Promise((resolve) => setTimeout(resolve, livenessMs * 1.5));

  assert.deepEqual(errors, []);
  assert.equal((await adapter.finalize()).text, "Kept.");
});

// Runs the server on its own thread, so it answers while the test blocks the
// main thread. Each ping is reported to the main thread before its pong.
async function threadedServer(t, pongDelayMs) {
  const worker = new Worker(
    `
    const { parentPort } = require("node:worker_threads");
    const { WebSocketServer } = require(${JSON.stringify(require.resolve("ws"))});
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1", autoPong: false });
    server.on("listening", () => parentPort.postMessage(server.address().port));
    server.on("connection", (socket) => {
      socket.on("ping", (data) => {
        parentPort.postMessage("ping");
        setTimeout(() => socket.pong(data), ${pongDelayMs});
      });
      socket.send(
        JSON.stringify({
          type: "ready",
          sample_rate: 16000,
          channels: 1,
          encoding: "pcm_s16le",
          max_seconds: 60,
        })
      );
    });
    `,
    { eval: true }
  );
  t.after(() => worker.terminate());
  const [port] = await once(worker, "message");
  return { worker, options: { baseUrl: `http://127.0.0.1:${port}`, apiKey: "test-key" } };
}

test(
  "a pong that arrived while the main thread was blocked counts",
  { timeout: 5000 },
  async (t) => {
    const { worker, options } = await threadedServer(t, 20);
    const livenessMs = 1000;
    const adapter = new OrukeetStreaming({ timeoutMs: 1000, livenessMs });
    t.after(() => adapter.disconnect());
    const errors = [];
    adapter.onError = (error) => errors.push(error);
    await adapter.connect(options);
    await once(adapter.ws, "pong");
    let pinged = false;
    const ping = adapter.ws.ping.bind(adapter.ws);
    adapter.ws.ping = () => {
      ping();
      adapter.ws.ping = ping;
      pinged = true;
    };
    worker.on("message", () => {
      if (!pinged) return;
      pinged = false;
      // Blocks until just past the next check's due time, so that check is on
      // time while the pong waiting on the socket is its only sign of life.
      const until = performance.now() + livenessMs * 0.65;
      while (performance.now() < until);
    });
    await new Promise((resolve) => setTimeout(resolve, livenessMs * 1.5));

    assert.deepEqual(errors, []);
  }
);

test("any server message keeps an armed stream alive", { timeout: 2000 }, async (t) => {
  const livenessMs = 200;
  const { adapter, options, control } = await stallableFixture(t, undefined, { livenessMs });
  const errors = [];
  adapter.onError = (error) => errors.push(error);
  await adapter.connect(options);
  await once(adapter.ws, "pong");
  control.answering = false;
  const language = JSON.stringify({ type: "language", language: "en", language_confidence: 0.9 });
  const chatter = setInterval(() => control.socket.send(language), livenessMs / 4);
  await new Promise((resolve) => setTimeout(resolve, livenessMs * 3));
  clearInterval(chatter);

  assert.deepEqual(errors, []);
});

test("a server that never answers pings is not judged stalled", { timeout: 2000 }, async (t) => {
  const { adapter, options, control } = await stallableFixture(
    t,
    (socket, event) => {
      if (event.type === "commit") socket.send(JSON.stringify({ type: "final", text: "Kept." }));
    },
    { livenessMs: 50 }
  );
  control.answering = false;
  await adapter.connect(options);
  adapter.sendAudio(Buffer.alloc(640));
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal((await adapter.finalize()).text, "Kept.");
});

test(
  "a commit awaiting its final is bounded by the final deadline, not liveness",
  { timeout: 2000 },
  async (t) => {
    const { adapter, options, control } = await stallableFixture(
      t,
      (socket, event) => {
        if (event.type !== "commit") return;
        // Inference can hold the server's event loop, so pongs stop meanwhile.
        control.answering = false;
        setTimeout(() => socket.send(JSON.stringify({ type: "final", text: "Slow." })), 200);
      },
      { livenessMs: 50, timeoutMs: 1000 }
    );
    await adapter.connect(options);
    await once(adapter.ws, "pong");
    adapter.sendAudio(Buffer.alloc(640));

    assert.equal((await adapter.finalize()).text, "Slow.");
  }
);

test("a closed stream stops checking liveness", { timeout: 2000 }, async (t) => {
  const { adapter, options } = await stallableFixture(t, undefined, { livenessMs: 50 });
  const errors = [];
  adapter.onError = (error) => errors.push(error);
  await adapter.connect(options);
  await once(adapter.ws, "pong");
  await adapter.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.deepEqual(errors, []);
});

// A ready socket whose writes complete only when the test says so, like an
// uplink still draining audio queued ahead of the commit.
async function heldSocketAdapter(t, adapterOptions) {
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    writes: [],
    send: (data, onSent) => socket.writes.push({ data, onSent }),
    close: () => {},
    terminate: () => {},
  });
  const adapter = new OrukeetStreaming({ createSocket: () => socket, ...adapterOptions });
  t.after(() => adapter.disconnect());
  const connected = adapter.connect({ baseUrl: "https://orukeet.test", apiKey: "test-key" });
  socket.emit(
    "message",
    JSON.stringify({
      type: "ready",
      sample_rate: 16000,
      channels: 1,
      encoding: "pcm_s16le",
      max_seconds: 60,
    })
  );
  await connected;
  const writeCommit = () => {
    const commit = socket.writes.at(-1);
    assert.equal(JSON.parse(commit.data).type, "commit");
    commit.onSent();
  };
  return { adapter, socket, writeCommit };
}

test(
  "the final deadline scales with the audio and starts once the commit is written",
  { timeout: 2000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { adapter, writeCommit } = await heldSocketAdapter(t, {
      finalTimeoutMs: (audioSeconds) => audioSeconds * 1000,
    });
    adapter.sendAudio(Buffer.alloc(64000)); // 2 s of 16 kHz PCM16
    const final = adapter.finalize();
    final.catch(() => {});

    t.mock.timers.tick(10000);
    assert.equal(adapter.failure, undefined);
    writeCommit();
    t.mock.timers.tick(1999);
    assert.equal(adapter.failure, undefined);
    t.mock.timers.tick(1);
    await assert.rejects(final, /final transcript timed out/);
  }
);

test(
  "a commit that is never written out still times out after 30 s",
  { timeout: 2000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { adapter } = await heldSocketAdapter(t, { finalTimeoutMs: () => 1000 });
    adapter.sendAudio(Buffer.alloc(640));
    const final = adapter.finalize();
    final.catch(() => {});

    t.mock.timers.tick(29999);
    assert.equal(adapter.failure, undefined);
    t.mock.timers.tick(1);
    await assert.rejects(final, /final transcript timed out/);
  }
);

test("a delivered final clears the 30 s cap", { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { adapter, socket, writeCommit } = await heldSocketAdapter(t, {
    finalTimeoutMs: () => 1000,
  });
  let closed = false;
  adapter.onClose = () => (closed = true);
  adapter.sendAudio(Buffer.alloc(640));
  const final = adapter.finalize();
  writeCommit();
  socket.emit("message", JSON.stringify({ type: "final", text: "Done." }));
  assert.equal((await final).text, "Done.");

  t.mock.timers.tick(30000);
  assert.equal(closed, false);
});

test("managed streams fail over within seconds instead of the 30 s budget", () => {
  assert.equal(MANAGED_STREAM_OPTIONS.retryCapacity, false);
  assert.equal(MANAGED_STREAM_OPTIONS.livenessMs, 8000);
  assert.equal(MANAGED_STREAM_OPTIONS.timeoutMs, 10000);
  assert.equal(MANAGED_STREAM_OPTIONS.finalTimeoutMs(0), 5000);
  assert.equal(MANAGED_STREAM_OPTIONS.finalTimeoutMs(60), 11000);
});
