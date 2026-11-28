const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  GnaniRealtimeStreaming,
  GnaniMeetingStreaming,
} = require("../../src/helpers/gnaniRealtimeStreaming");

function recording(t, Client = GnaniRealtimeStreaming, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  t.mock.method(performance, "now", () => Date.now());
  const sockets = [];
  class Socket extends EventEmitter {
    constructor(url, options) {
      super();
      this.url = url;
      this.headers = options.headers;
      this.sent = [];
      this.readyState = 1;
      sockets.push(this);
    }
    json(event) {
      this.emit("message", JSON.stringify(event));
    }
    accept() {
      this.json({
        type: "connected",
        config: {
          sample_rate: 16000,
          chunk_size: 512,
          language_code: this.headers.language_code,
          format: this.headers.format,
        },
      });
    }
    send(data) {
      this.sent.push({ data, at: Date.now() });
    }
    close() {
      this.readyState = 3;
      this.emit("close", 1000);
    }
  }
  const client = new Client(Socket);
  const ready = client.connect({
    apiKey: "test-credential",
    model: "prisma-v3.0",
    language: "auto",
    keyterms: ["विद्या"],
    ...options,
  });
  t.after(() => client.disconnect({ commit: false }));
  return { client, sockets, ready, tick: (ms) => t.mock.timers.tick(ms) };
}

test("Prisma waits for server configuration and paces complete PCM frames including the padded tail", async (t) => {
  const {
    client,
    sockets: [ws],
    ready,
    tick,
  } = recording(t);
  const data = Buffer.alloc(1030, 64);
  client.sendAudio(data.subarray(0, 510));
  client.sendAudio(data.subarray(510));
  assert.equal(ws.sent.length, 0);
  assert.deepEqual(
    [ws.url, ws.headers.model, ws.headers.language_code, ws.headers.format],
    ["wss://api.vachana.ai/stt/v3/stream", "prisma-v3.0", "indic-auto", "codemix"]
  );
  assert.match(ws.headers.keyterms, /\\u/);
  ws.accept();
  await ready;
  assert.deepEqual(ws.sent[0].data, data.subarray(0, 1024));
  const final = client.finalize();
  tick(31);
  assert.equal(ws.sent.length, 1);
  tick(1);
  assert.deepEqual(ws.sent[1].data, Buffer.concat([data.subarray(1024), Buffer.alloc(1018)]));
  assert.equal(ws.sent[1].at - ws.sent[0].at, 32);
  tick(32);
  assert.deepEqual(JSON.parse(ws.sent[2].data), { type: "commit" });
  // A slow utterance arriving after a full second must still reach the result.
  ws.json({ type: "speech_start", utterance_id: "last", t_ms: 0 });
  tick(1700);
  ws.json({
    type: "transcript",
    segment_id: "one",
    utterance_id: "last",
    text: "weather today",
    detected_language_code: "en-IN",
    audio_duration_ms: 64,
  });
  assert.deepEqual(await final, {
    text: "weather today",
    model: "prisma-v3.0",
    language: "en-IN",
    audioBytesSent: 2048,
  });
});

test("Prisma v2.5 sends the explicit model, language and format and accepts genuine silence", async (t) => {
  const {
    client,
    sockets: [ws],
    ready,
    tick,
  } = recording(t, GnaniRealtimeStreaming, { model: "prisma-v2.5" });
  assert.equal(ws.headers.language_code, "en-IN");
  assert.equal(ws.headers.model, "prisma-v2.5");
  assert.equal(ws.headers.format, "transcribe");
  assert.equal(ws.headers.keyterms, undefined);
  ws.accept();
  await ready;
  client.sendAudio(Buffer.alloc(1000));
  const final = client.finalize();
  tick(32);
  tick(900);
  assert.equal((await final).text, "");
});

test("an unrecognized audible tail fails explicitly and retains completed utterances", async (t) => {
  const {
    client,
    sockets: [ws],
    ready,
    tick,
  } = recording(t);
  ws.accept();
  await ready;
  client.sendAudio(Buffer.alloc(1024, 60));
  ws.json({ type: "speech_start", utterance_id: "a", t_ms: 0 });
  ws.json({
    type: "transcript",
    segment_id: "first",
    utterance_id: "a",
    text: "first",
    audio_duration_ms: 32,
  });
  client.sendAudio(Buffer.alloc(1024, 60));
  tick(32);
  const rejected = assert.rejects(client.finalize(), /last utterance/);
  tick(32);
  tick(6000);
  await rejected;
  assert.equal((await client.disconnect()).text, "first");
});

test("meeting reconnect replays unfinalized source audio and timestamps repeated speech from each original capture", async (t) => {
  const { client, sockets, ready, tick } = recording(t, GnaniMeetingStreaming);
  const [first] = sockets;
  first.accept();
  await ready;
  const finals = [];
  client.onFinalTranscript = (text, at) => finals.push([text, at]);
  const capture = Buffer.alloc(1536, 40);
  client.sendAudio(capture, 1400);
  first.json({ type: "speech_start", utterance_id: "a", t_ms: 0 });
  const event = {
    type: "transcript",
    utterance_id: "a",
    segment_id: "seg-1",
    text: "again",
    audio_duration_ms: 32,
  };
  first.json(event);
  first.json(event);
  client.sendAudio(capture, 1600);
  tick(32);
  first.emit("close", 1006);
  client.sendAudio(capture, 1632);
  tick(250);
  const second = sockets[1];
  assert.deepEqual(second.headers, first.headers);
  second.accept();
  assert.equal(second.sent.length, 1);
  tick(32);
  assert.deepEqual(
    second.sent.map(({ data }) => [data.length, data[0]]),
    [
      [1024, 40],
      [1024, 40],
    ]
  );
  second.json({ type: "speech_start", utterance_id: "a", t_ms: 0 });
  second.json({ ...event, audio_duration_ms: 64 });
  assert.deepEqual(finals, [
    ["again", 1400],
    ["again", 1600],
  ]);
  const final = client.disconnect();
  tick(32);
  tick(900);
  assert.equal((await final).text, "again again");
});

test("a session renews before the service limit and cancel disposes a reconnect", async (t) => {
  const { client, sockets, ready, tick } = recording(t);
  sockets[0].accept();
  await ready;
  tick(870000);
  assert.deepEqual(JSON.parse(sockets[0].sent.at(-1).data), { type: "commit" });
  client.sendAudio(Buffer.alloc(1024, 30));
  tick(900);
  assert.equal(sockets.length, 2);
  sockets[1].accept();
  assert.equal(sockets[1].sent[0].data[0], 30);
  sockets[1].emit("close", 1006);
  await client.disconnect();
  tick(5000);
  assert.equal(sockets.length, 2);
});

for (const final of ["missing", "empty", "socket closed"]) {
  test(`a v2.5 meeting recovers a ${final} final without repeating acknowledged speech`, async (t) => {
    const { client, sockets, ready, tick } = recording(t, GnaniMeetingStreaming, {
      model: "prisma-v2.5",
      language: "hi",
    });
    const [ws] = sockets;
    const request = t.mock.method(globalThis, "fetch", async (url, { headers, body }) => {
      assert.equal(url, "https://api.vachana.ai/stt/v3");
      assert.equal(headers["X-API-Key-ID"], ws.headers["x-api-key-id"]);
      assert.equal(body.get("model"), "prisma-v2.5");
      assert.equal(body.get("language_code"), "hi-IN");
      const wav = Buffer.from(await body.get("audio_file").arrayBuffer());
      assert.deepEqual(wav.subarray(44), ws.sent[1].data);
      return Response.json({ success: true, transcript: "second" });
    });
    ws.accept();
    await ready;
    client.sendAudio(Buffer.alloc(1536, 20), 1000);
    const event = { type: "transcript", text: "", audio_duration_ms: 32 };
    ws.json({ ...event, utterance_id: "one", output: { literal: "first" } });
    client.sendAudio(Buffer.alloc(1536, 40), 1032);
    tick(32);
    ws.json({ type: "speech_start", utterance_id: "two", t_ms: 32 });
    if (final === "empty") ws.json({ ...event, utterance_id: "two" });

    const stopped = client.disconnect();
    tick(32);
    if (final === "socket closed") ws.emit("close", 1006);
    else tick(6000);
    assert.equal((await stopped).text, "first second");
    assert.equal(request.mock.callCount(), 1);
    assert.equal(sockets.length, 1);
  });
}

test("a v2.5 meeting reports incomplete audio when REST also has no words", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ success: true, transcript: "" }));
  const { client, sockets, ready, tick } = recording(t, GnaniMeetingStreaming, {
    model: "prisma-v2.5",
  });
  sockets[0].accept();
  await ready;
  client.sendAudio(Buffer.alloc(1536, 40));
  const stopped = client.disconnect();
  tick(32);
  tick(6000);
  assert.equal((await stopped).incomplete, true);
});

test("retiring a v2.5 recording aborts REST and discards a late result", async (t) => {
  const response = Promise.withResolvers();
  const request = t.mock.method(globalThis, "fetch", () => response.promise);
  const { client, sockets, ready, tick } = recording(t, GnaniMeetingStreaming, {
    model: "prisma-v2.5",
  });
  sockets[0].accept();
  await ready;
  client.sendAudio(Buffer.alloc(1536, 40));
  const stopped = client.disconnect();
  tick(32);
  tick(6000);
  await client.disconnect({ commit: false });
  assert.equal(request.mock.calls[0].arguments[1].signal.aborted, true);
  response.resolve(Response.json({ success: true, transcript: "late" }));
  assert.equal((await stopped).text, "");
  await new Promise(setImmediate);
  assert.deepEqual(client.completedSegments, []);
});

test("a silent v2.5 meeting lane closes without retrying an empty final", async (t) => {
  const { client, sockets, ready, tick } = recording(t, GnaniMeetingStreaming, {
    model: "prisma-v2.5",
  });
  sockets[0].accept();
  await ready;
  client.sendAudio(Buffer.alloc(1536));
  sockets[0].json({ type: "transcript", utterance_id: "silent", text: "", audio_duration_ms: 32 });
  const stopped = client.disconnect();
  tick(32);
  tick(900);
  assert.equal((await stopped).text, "");
  assert.equal(sockets.length, 1);
});

test("a lost commit response replays the outstanding utterance on the same key", async (t) => {
  const { client, sockets, ready, tick } = recording(t, GnaniMeetingStreaming);
  const [original] = sockets;
  original.accept();
  await ready;
  client.sendAudio(Buffer.alloc(1536, 40), 1200);
  original.json({ type: "speech_start", utterance_id: "lost", t_ms: 0 });
  const done = client.disconnect();
  tick(32);
  assert.deepEqual(JSON.parse(original.sent.at(-1).data), { type: "commit" });
  original.emit("close", 1006);
  tick(250);
  const replacement = sockets[1];
  assert.deepEqual(replacement.headers, original.headers);
  replacement.accept();
  assert.deepEqual(replacement.sent[0].data, original.sent[0].data);
  replacement.json({ type: "speech_start", utterance_id: "recovered", t_ms: 0 });
  tick(32);
  replacement.json({
    type: "transcript",
    utterance_id: "recovered",
    text: "tail",
    audio_duration_ms: 32,
  });
  replacement.emit("close", 1000);
  assert.equal((await done).text, "tail");
});

test("a dropped first handshake retries with the original key and queued microphone audio", async (t) => {
  const { client, sockets, ready, tick } = recording(t);
  const audio = Buffer.alloc(1024, 40);
  client.sendAudio(audio);
  sockets[0].emit("close", 1006);
  tick(250);
  assert.equal(sockets.length, 2);
  assert.deepEqual(sockets[1].headers, sockets[0].headers);
  assert.deepEqual(sockets[0].sent, []);
  sockets[1].accept();
  await ready;
  assert.deepEqual(
    sockets[1].sent.map(({ data }) => data),
    [audio]
  );
});

test("an unavailable realtime endpoint gives up after one startup retry", async (t) => {
  const { sockets, ready, tick } = recording(t);
  const rejected = assert.rejects(ready, /stream connection failed/);
  sockets[0].emit("error", new Error("Connection reset"));
  tick(250);
  sockets[1].emit("error", new Error("Connection reset"));
  await rejected;
  tick(10_000);
  assert.equal(sockets.length, 2);
});

test("rejects a server handshake that selected another model or incompatible PCM", async (t) => {
  const {
    sockets: [ws],
    ready,
  } = recording(t);
  ws.json({
    type: "connected",
    config: { sample_rate: 8000, chunk_size: 512, model: "prisma-v2.5" },
  });
  await assert.rejects(ready, /different recording settings/);
});

for (const [rejection, code] of [
  [401, "PROVIDER_AUTH_FAILED"],
  [403, "PROVIDER_ACCESS_DENIED"],
  ["Concurrent stream limit reached", "PROVIDER_RATE_LIMITED"],
  ["Insufficient credits", "PROVIDER_QUOTA_EXHAUSTED"],
]) {
  test(`a handshake refusal reports ${code} without replaying audio`, async (t) => {
    const { client, sockets, ready, tick } = recording(t);
    client.sendAudio(Buffer.alloc(1024, 40));
    const [ws] = sockets;
    if (typeof rejection === "number") {
      ws.emit("unexpected-response", { destroy() {} }, { statusCode: rejection, destroy() {} });
    } else {
      ws.json({ type: "error", message: rejection });
    }
    await assert.rejects(ready, { code });
    tick(5000);
    assert.equal(sockets.length, 1);
    assert.deepEqual(ws.sent, []);
  });
}

test("out-of-order finals are delivered and checkpointed in source order", async (t) => {
  const {
    client,
    sockets: [ws],
    ready,
    tick,
  } = recording(t);
  ws.accept();
  await ready;
  const frame = Buffer.alloc(1024, 30);
  client.sendAudio(frame);
  ws.json({ type: "speech_start", utterance_id: "first", t_ms: 0 });
  client.sendAudio(frame);
  tick(32);
  ws.json({ type: "speech_start", utterance_id: "second", t_ms: 32 });
  const final = client.finalize();
  tick(32);
  const emitFinal = (segment_index, text) =>
    ws.json({
      type: "transcript",
      utterance_id: text,
      segment_index,
      text,
      audio_duration_ms: 32,
    });
  emitFinal(2, "second");
  assert.equal(client.result().text, "");
  emitFinal(1, "first");
  emitFinal(2, "second");
  tick(900);
  assert.equal((await final).text, "first second");
});

test("Prisma rotates before 15 minutes and delivers audio captured while the old socket drains", async (t) => {
  const { client, sockets, ready, tick } = recording(t);
  const first = sockets[0];
  first.accept();
  await ready;
  client.sendAudio(Buffer.alloc(1024, 40));
  first.json({ type: "transcript", utterance_id: "first", text: "Before", audio_duration_ms: 32 });
  tick(14 * 60000 + 30000);
  assert.deepEqual(JSON.parse(first.sent.at(-1).data), { type: "commit" });
  const after = Buffer.alloc(1024, 50);
  client.sendAudio(after);
  const final = client.finalize();
  tick(900);
  assert.equal(sockets.length, 2);
  const next = sockets[1];
  assert.deepEqual(next.headers, first.headers);
  next.accept();
  assert.deepEqual(next.sent[0].data, after);
  next.json({ type: "transcript", utterance_id: "next", text: "after", audio_duration_ms: 32 });
  tick(32);
  tick(900);
  assert.equal((await final).text, "Before after");
});

test("an idle meeting lane opens a fresh session only when its source resumes", async (t) => {
  const { client, sockets, ready, tick } = recording(t, GnaniMeetingStreaming);
  sockets[0].accept();
  await ready;
  sockets[0].json({ type: "error", message: "No audio received (idle timeout)" });
  tick(15000);
  assert.equal(sockets.length, 1);
  client.sendAudio(Buffer.alloc(1536), 18200);
  assert.equal(sockets.length, 2);
  sockets[1].accept();
  assert.equal(sockets[1].sent[0].data.length, 1024);
  const result = client.disconnect();
  tick(32);
  tick(900);
  assert.equal((await result).text, "");
});

test("a partial frame before a device interruption keeps the new chunk on its source clock", async (t) => {
  const {
    client,
    sockets: [ws],
    ready,
    tick,
  } = recording(t, GnaniMeetingStreaming);
  ws.accept();
  await ready;
  client.sendAudio(Buffer.alloc(768, 40), 1000);
  client.sendAudio(Buffer.alloc(2304, 40), 4016);
  tick(32);
  let startedAt;
  client.onFinalTranscript = (_text, at) => {
    startedAt = at;
  };
  ws.json({ type: "speech_start", utterance_id: "after", t_ms: 32 });
  ws.json({ type: "transcript", utterance_id: "after", text: "again", audio_duration_ms: 32 });
  assert.equal(startedAt, 4032);
});
