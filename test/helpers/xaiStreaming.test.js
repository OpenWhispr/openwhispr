const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

const { WebSocketServer } = require("ws");

const XaiStreaming = require("../../src/helpers/xaiStreaming");

// Mock of xAI's streaming STT protocol: `transcript.created` on open, raw PCM
// in, `transcript.partial` events out, `audio.done` → `transcript.done` + close.
async function startMockXaiServer({ onBinary, onControl } = {}) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");

  const requests = [];
  const controls = [];
  const audioFrames = [];
  wss.on("connection", (socket, request) => {
    requests.push(request);
    socket.send(JSON.stringify({ type: "transcript.created" }));
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        audioFrames.push(Buffer.from(data));
        onBinary?.(socket, data, audioFrames.length);
        return;
      }
      const message = JSON.parse(data.toString());
      controls.push(message.type);
      onControl?.(socket, message);
      if (message.type === "audio.done") {
        socket.send(JSON.stringify({ type: "transcript.done", text: "full transcript" }));
        socket.close(1000);
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${wss.address().port}/v1/stt`,
    requests,
    controls,
    audioFrames,
    close: () => new Promise((resolve) => wss.close(resolve)),
  };
}

const pcm = (bytes = 960) => Buffer.alloc(bytes);

test("connects with Bearer auth and query-string configuration", async (t) => {
  const server = await startMockXaiServer();
  t.after(server.close);
  const client = new XaiStreaming(server.url);

  await client.connect({
    apiKey: "xai-key",
    sampleRate: 24000,
    language: "en",
    keyterms: ["OpenWhispr", " ", "x".repeat(51)],
  });

  assert.equal(client.isConnected, true);
  const [request] = server.requests;
  assert.equal(request.headers.authorization, "Bearer xai-key");
  const params = new URL(request.url, "ws://localhost").searchParams;
  assert.equal(params.get("sample_rate"), "24000");
  assert.equal(params.get("encoding"), "pcm");
  assert.equal(params.get("interim_results"), "true");
  assert.equal(params.get("language"), "en");
  assert.deepEqual(params.getAll("keyterm"), ["OpenWhispr"]);

  await client.disconnect();
});

test("omits a language xAI does not support and auto", async (t) => {
  const server = await startMockXaiServer();
  t.after(server.close);

  for (const language of ["auto", "zz"]) {
    const client = new XaiStreaming(server.url);
    await client.connect({ apiKey: "k", language });
    const params = new URL(server.requests.at(-1).url, "ws://localhost").searchParams;
    assert.equal(params.has("language"), false, `${language} must not be sent`);
    await client.disconnect();
  }
});

test("interim results are partials; each chunk final becomes one timed segment", async (t) => {
  const server = await startMockXaiServer({
    onBinary: (socket, _data, count) => {
      if (count === 1) {
        socket.send(JSON.stringify({ type: "transcript.partial", text: "hel", is_final: false }));
      } else if (count === 2) {
        socket.send(
          JSON.stringify({
            type: "transcript.partial",
            text: " hello there ",
            is_final: true,
            speech_final: false,
            start: 1.5,
          })
        );
      } else if (count === 3) {
        socket.send(
          JSON.stringify({
            type: "transcript.partial",
            text: "general kenobi",
            is_final: true,
            speech_final: true,
            start: 3,
          })
        );
      }
    },
  });
  t.after(server.close);

  const client = new XaiStreaming(server.url);
  const partials = [];
  const finals = [];
  client.onPartialTranscript = (text) => partials.push(text);
  client.onFinalTranscript = (text, timestamp) => finals.push({ text, timestamp });

  await client.connect({ apiKey: "k", sampleRate: 24000 });
  const startedAt = client.sessionStartedAt;
  for (let index = 0; index < 3; index += 1) client.sendAudio(pcm());
  const result = await client.disconnect();

  assert.deepEqual(partials, ["hel"]);
  assert.deepEqual(
    finals.map(({ text }) => text),
    ["hello there", "hello there general kenobi"]
  );
  assert.equal(finals[0].timestamp, startedAt + 1500);
  assert.equal(finals[1].timestamp, startedAt + 3000);
  assert.equal(result.text, "hello there general kenobi");
  assert.equal(client.audioBytesSent, 3 * 960);
});

test("disconnect finalizes then ends the audio, and does not append transcript.done", async (t) => {
  const server = await startMockXaiServer({
    onControl: (socket, message) => {
      if (message.type === "finalize") {
        socket.send(
          JSON.stringify({ type: "transcript.partial", text: "tail words", is_final: true })
        );
      }
    },
  });
  t.after(server.close);

  const client = new XaiStreaming(server.url);
  await client.connect({ apiKey: "k" });
  client.sendAudio(pcm());
  const result = await client.disconnect();

  assert.deepEqual(server.controls, ["finalize", "audio.done"]);
  assert.equal(result.text, "tail words");
  assert.equal(client.isConnected, false);
});

test("an unexpected close mid-session reports connection loss once", async (t) => {
  const server = await startMockXaiServer({
    onBinary: (socket) => socket.close(1011),
  });
  t.after(server.close);

  const client = new XaiStreaming(server.url);
  const lost = [];
  client.onConnectionLost = (error) => lost.push(error.message);
  await client.connect({ apiKey: "k" });
  client.sendAudio(pcm());
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(lost.length, 1);
  assert.match(lost[0], /1011/);
  assert.equal(client.isConnected, false);
});

test("a missing key is refused before any socket opens", async () => {
  const client = new XaiStreaming("ws://127.0.0.1:1/never");
  await assert.rejects(client.connect({}), /requires an API key/);
});

// Field case from a live meeting: `finalize` locked the sentence, then the
// utterance final after `audio.done` repeated it, and the note showed it twice.
const finalsFor = (events) => {
  const client = new XaiStreaming("ws://unused");
  client.sessionStartedAt = 0;
  const emitted = [];
  client.onFinalTranscript = () => emitted.push(client.completedSegments.at(-1));
  for (const event of events) {
    client.handleMessage(Buffer.from(JSON.stringify({ type: "transcript.partial", ...event })));
  }
  return emitted;
};

test("a final repeated after finalize is committed once, with or without timing", () => {
  const sentence = "Hi, how are you? What are you doing?";
  assert.deepEqual(
    finalsFor([
      { text: sentence, is_final: true, speech_final: true, start: 0, duration: 2.4 },
      { text: sentence, is_final: true, speech_final: true, start: 0, duration: 2.4 },
    ]),
    [sentence]
  );
  assert.deepEqual(
    finalsFor([
      { text: sentence, is_final: true },
      { text: sentence, is_final: true, speech_final: true },
    ]),
    [sentence]
  );
});

test("a repeat that differs only in case and punctuation is still dropped", () => {
  assert.deepEqual(
    finalsFor([
      { text: "Hi, how are you?", is_final: true, start: 0, duration: 1 },
      { text: "hi how are you", is_final: true, start: 0, duration: 1 },
    ]),
    ["Hi, how are you?"]
  );
});

test("a phrase genuinely said twice on new audio is kept both times", () => {
  assert.deepEqual(
    finalsFor([
      { text: "Thanks.", is_final: true, speech_final: true, start: 0, duration: 0.6 },
      { text: "Thanks.", is_final: true, speech_final: true, start: 4, duration: 0.6 },
    ]),
    ["Thanks.", "Thanks."]
  );
});

test("a cumulative utterance final keeps only the words not yet committed", () => {
  assert.deepEqual(
    finalsFor([
      { text: "We should ship the release", is_final: true, start: 0, duration: 3 },
      {
        text: "We should ship the release on Friday afternoon",
        is_final: true,
        speech_final: true,
        start: 0,
        duration: 4.5,
      },
    ]),
    ["We should ship the release", "on Friday afternoon"]
  );
});

test("one shared word with new speech is not mistaken for a restatement", () => {
  assert.deepEqual(
    finalsFor([
      { text: "I think so", is_final: true },
      { text: "so what now", is_final: true },
    ]),
    ["I think so", "so what now"]
  );
});
