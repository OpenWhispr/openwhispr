const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  SarvamRealtimeStreaming,
  SarvamMeetingStreaming,
} = require("../../src/helpers/sarvamRealtimeStreaming");

class Socket extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.headers = options.headers;
    this.sent = [];
    this.readyState = 1;
  }
  receive(event) {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
}

for (const model of ["saaras:v4", "saaras:v3"]) {
  test(`${model} streams partials and waits for the last utterance before pasting`, async () => {
    const stream = new SarvamRealtimeStreaming(Socket);
    const partials = [];
    stream.onPartialTranscript = (text) => partials.push(text);
    const ready = stream.connect({
      apiKey: "saved",
      model,
      language: "or",
      keyterms: ["OpenWhispr"],
    });
    const socket = stream.ws;
    assert.equal(socket.url.origin, "wss://api.sarvam.ai");
    assert.equal(socket.url.pathname, "/speech-to-text-realtime/ws");
    assert.equal(
      socket.url.searchParams.get("model"),
      model === "saaras:v3" ? "saaras:v3-realtime" : model
    );
    assert.equal(socket.url.searchParams.get("language_code"), "or-IN");
    assert.equal(socket.url.searchParams.get("mode"), "transcribe");
    assert.equal(
      socket.url.searchParams.get("keyterms"),
      model === "saaras:v4" ? '["OpenWhispr"]' : null
    );
    assert.equal(socket.headers["Api-Subscription-Key"], "saved");
    socket.receive({ event: "session.begin" });
    await ready;
    stream.sendAudio(Buffer.from([1, 2]));
    socket.receive({ event: "transcript.partial", utterance_idx: 0, text: "नम" });
    socket.receive({ event: "transcript.final", utterance_idx: 0, text: "नमस्ते" });
    socket.receive({ event: "transcript.partial", utterance_idx: 1, text: "भा" });
    const final = stream.finalize();
    assert.deepEqual(socket.sent, [{ event: "audio_input", audio: "AQI=" }, { event: "end" }]);
    socket.receive({ event: "transcript.final", utterance_idx: 1, text: "भारत" });
    socket.receive({ event: "session.end" });
    assert.deepEqual(partials, ["नम", "भा"]);
    assert.deepEqual(await final, { text: "नमस्ते भारत", model, audioBytesSent: 2 });
    assert.equal((await stream.disconnect()).text, "नमस्ते भारत");
  });
}

test("an interrupted Sarvam stream cannot deliver an earlier utterance as the completed recording", async () => {
  const stream = new SarvamRealtimeStreaming(Socket);
  const ready = stream.connect({ apiKey: "saved", model: "saaras:v4" });
  stream.ws.receive({ event: "session.begin" });
  await ready;
  stream.ws.receive({ event: "transcript.final", utterance_idx: 0, text: "first phrase" });
  const final = stream.finalize();
  stream.ws.emit("close", 1006);
  await assert.rejects(final, /closed before completion/);
  assert.equal((await stream.disconnect()).text, "");
});

test("cancelling during a Sarvam handshake rejects the start without finalizing audio", async () => {
  const stream = new SarvamRealtimeStreaming(Socket);
  const ready = stream.connect({ apiKey: "saved", model: "saaras:v3" });
  await stream.disconnect();
  await assert.rejects(ready, /cancelled/);
  assert.deepEqual(stream.ws.sent, []);
});

for (const model of ["saaras:v4", "saaras:v3"]) {
  test(`${model} note recording converts split PCM and drains each timestamped final once`, async () => {
    const stream = new SarvamMeetingStreaming(Socket);
    const ready = stream.connect({ apiKey: "saved", model });
    const socket = stream.ws;
    assert.equal(socket.url.searchParams.get("return_timestamps"), "true");
    socket.receive({ event: "session.begin" });
    await ready;
    // Six samples across uneven frames should produce exactly four samples at 16 kHz.
    const pcm = Buffer.from(Int16Array.from([0, 2, 4, 6, 8, 10]).buffer);
    assert.equal(stream.sendAudio(pcm.subarray(0, 4)), true);
    assert.equal(stream.sendAudio(pcm.subarray(4, 8)), true);
    assert.equal(stream.sendAudio(pcm.subarray(8)), true);
    const outbound = Buffer.concat(socket.sent.map(({ audio }) => Buffer.from(audio, "base64")));
    assert.deepEqual(outbound, Buffer.from(Int16Array.from([0, 3, 6, 9]).buffer));
    stream.sessionStartedAt = 10000;
    const finals = [];
    stream.onFinalTranscript = (text, timestamp) => finals.push([text, timestamp]);
    const first = { event: "transcript.final", utterance_idx: 0, text: "पहला", start_s: 0 };
    socket.receive(first);
    socket.receive(first);
    const stop = stream.disconnect();
    assert.equal(socket.sent.at(-1).event, "end");
    socket.receive({ event: "transcript.final", utterance_idx: 1, text: "दूसरा", start_s: 1.5 });
    socket.receive({ event: "session.end" });
    assert.deepEqual(finals, [
      ["पहला", 10000],
      ["दूसरा", 11500],
    ]);
    assert.deepEqual(stream.completedSegments, ["पहला", "दूसरा"]);
    assert.equal((await stop).text, "पहला दूसरा");
  });
}

test("a coalesced read is split under Sarvam's frame cap and a rejected frame keeps the stream", async () => {
  const stream = new SarvamMeetingStreaming(Socket);
  const ready = stream.connect({ apiKey: "saved", model: "saaras:v4" });
  stream.ws.receive({ event: "session.begin" });
  await ready;
  // 1.5 s of 24 kHz audio in one read becomes 48,000 bytes at 16 kHz.
  const pcm = Buffer.alloc(72000, 1);
  assert.equal(stream.sendAudio(pcm), true);
  const frames = stream.ws.sent.map(({ audio }) => Buffer.from(audio, "base64").length);
  assert.deepEqual(frames, [8000, 8000, 8000, 8000, 8000, 8000]);
  assert.equal(stream.audioBytesSent, 48000);
  stream.ws.receive({ event: "error", code: "chunk_too_large", is_fatal: false });
  assert.equal(stream.isConnected, true);
  await stream.disconnect({ commit: false });
});

test("a socket with no audio is kept alive until it closes", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const stream = new SarvamMeetingStreaming(Socket);
  const ready = stream.connect({ apiKey: "saved", model: "saaras:v4" });
  stream.ws.receive({ event: "session.begin" });
  await ready;
  t.mock.timers.tick(40000);
  assert.deepEqual(stream.ws.sent, [{ event: "ping" }, { event: "ping" }]);
  stream.ws.receive({ event: "pong" });
  await stream.disconnect({ commit: false });
  t.mock.timers.tick(40000);
  assert.equal(stream.ws.sent.length, 2);
});

test("meeting loss triggers recovery only for an active socket, and policy cancellation does not flush", async () => {
  for (const cancel of [false, true]) {
    const stream = new SarvamMeetingStreaming(Socket);
    const ready = stream.connect({ apiKey: "saved", model: "saaras:v4" });
    stream.ws.receive({ event: "session.begin" });
    await ready;
    stream.sendAudio(Buffer.alloc(960));
    const recovered = [];
    stream.onConnectionLost = () => recovered.push(stream.isConnected);
    if (cancel) await stream.disconnect({ commit: false });
    stream.ws.emit("close", 1006);
    assert.deepEqual(recovered, cancel ? [] : [false]);
    assert.equal(stream.sendAudio(Buffer.alloc(960)), false);
    assert.equal(
      stream.ws.sent.some(({ event }) => event === "end"),
      false
    );
  }
});
