const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { WebSocketServer } = require("ws");
const { OrukeetStreaming, streamingUrl } = require("../../src/helpers/orukeetStreaming");

async function fixture(t, onMessage) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const seen = [];
  server.on("connection", (socket, request) => {
    assert.equal(request.headers.authorization, "Bearer test-key");
    assert.equal(request.url, "/v1/audio/transcriptions/stream");
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
  const adapter = new OrukeetStreaming({ timeoutMs: 300 });
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
  await assert.rejects(adapter.finalize(), /timed out/);
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
