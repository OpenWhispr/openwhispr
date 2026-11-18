const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/sttApiStreamPolicy.js");

test("stream URL: https becomes wss, with or without /v1 and a trailing slash", async () => {
  const { sttApiStreamUrl } = await load();

  const expected = "wss://stt.example.test/v1/transcriptions/stream";
  assert.equal(sttApiStreamUrl("https://stt.example.test/v1"), expected);
  assert.equal(sttApiStreamUrl("https://stt.example.test/v1/"), expected);
  assert.equal(sttApiStreamUrl("https://stt.example.test"), expected);
  assert.equal(sttApiStreamUrl("https://stt.example.test/"), expected);
  assert.equal(
    sttApiStreamUrl("https://stt.example.test:8443/prefix/v1"),
    "wss://stt.example.test:8443/prefix/v1/transcriptions/stream"
  );
});

test("stream URL never carries a query or fragment", async () => {
  const { sttApiStreamUrl } = await load();

  assert.equal(
    sttApiStreamUrl("https://stt.example.test/v1?token=secret#frag"),
    "wss://stt.example.test/v1/transcriptions/stream"
  );
});

test("stream URL: ws:// only for loopback hosts, otherwise refused", async () => {
  const { sttApiStreamUrl } = await load();

  assert.equal(
    sttApiStreamUrl("http://127.0.0.1:9000/v1"),
    "ws://127.0.0.1:9000/v1/transcriptions/stream"
  );
  assert.equal(
    sttApiStreamUrl("http://localhost:9000"),
    "ws://localhost:9000/v1/transcriptions/stream"
  );
  assert.throws(() => sttApiStreamUrl("http://stt.example.test/v1"), /non-TLS/);
  assert.throws(() => sttApiStreamUrl("ftp://stt.example.test/v1"), /non-TLS/);
  assert.throws(() => sttApiStreamUrl("not a url"), /not a valid URL/);
  assert.throws(() => sttApiStreamUrl(""), /not a valid URL/);
});

test("frame parser: typed frames for partial, segment, final and error", async () => {
  const { parseSttApiFrame } = await load();

  assert.deepEqual(parseSttApiFrame('{"type":"partial","text":"hello wor"}'), {
    type: "partial",
    text: "hello wor",
  });
  assert.deepEqual(parseSttApiFrame('{"type":"segment","index":3,"text":"hi","final":true}'), {
    type: "segment",
    index: 3,
    text: "hi",
    final: true,
  });
  assert.deepEqual(parseSttApiFrame('{"type":"segment","index":3,"text":"hi"}'), {
    type: "segment",
    index: 3,
    text: "hi",
    final: false,
  });
  assert.deepEqual(
    parseSttApiFrame(Buffer.from('{"type":"final","text":"all","truncated":true}')),
    {
      type: "final",
      text: "all",
      truncated: true,
    }
  );
  assert.deepEqual(
    parseSttApiFrame('{"type":"error","error":{"code":"busy","message":"pool full"}}'),
    { type: "error", code: "busy", message: "pool full" }
  );
});

test("frame parser ignores unknown types and rejects malformed or oversized fields", async () => {
  const { parseSttApiFrame, MAX_FRAME_TEXT_LENGTH } = await load();

  assert.equal(parseSttApiFrame('{"type":"metadata"}'), null);
  assert.equal(parseSttApiFrame("not json"), null);
  assert.equal(parseSttApiFrame("null"), null);
  assert.equal(parseSttApiFrame('{"type":"partial","text":42}'), null);
  assert.equal(parseSttApiFrame('{"type":"segment","index":"1","text":"x"}'), null);
  assert.equal(parseSttApiFrame('{"type":"segment","index":1.5,"text":"x"}'), null);
  assert.equal(
    parseSttApiFrame(
      JSON.stringify({ type: "partial", text: "a".repeat(MAX_FRAME_TEXT_LENGTH + 1) })
    ),
    null
  );
  assert.deepEqual(
    parseSttApiFrame(JSON.stringify({ type: "partial", text: "a".repeat(MAX_FRAME_TEXT_LENGTH) })),
    { type: "partial", text: "a".repeat(MAX_FRAME_TEXT_LENGTH) }
  );
});

const pcm = (samples) => {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => buffer.writeInt16LE(value, i * 2));
  return buffer;
};
const samplesOf = (buffer) => {
  const out = [];
  for (let i = 0; i < buffer.length; i += 2) out.push(buffer.readInt16LE(i));
  return out;
};

test("resampler: 24 kHz in, 16 kHz out, even-length frames at about 2/3 the sample count", async () => {
  const { Pcm16Resampler } = await load();
  const resampler = new Pcm16Resampler(24000, 16000);

  const out = resampler.process(pcm(Array.from({ length: 2400 }, (_, i) => (i % 100) * 100)));
  assert.equal(out.length % 2, 0);
  assert.ok(Math.abs(out.length / 2 - 1600) <= 2, `got ${out.length / 2} samples`);
});

test("resampler: chunked output equals whole-buffer output, including odd byte splits", async () => {
  const { Pcm16Resampler } = await load();
  const input = pcm(Array.from({ length: 6000 }, (_, i) => Math.round(Math.sin(i / 7) * 12000)));

  const whole = new Pcm16Resampler(24000, 16000).process(input);

  for (const sizes of [[480, 481, 1, 999, 4001], [2, 3, 5, 8, 13, 21], [input.length]]) {
    const chunked = new Pcm16Resampler(24000, 16000);
    const parts = [];
    let offset = 0;
    let i = 0;
    while (offset < input.length) {
      const size = sizes[i++ % sizes.length];
      parts.push(chunked.process(input.subarray(offset, Math.min(offset + size, input.length))));
      offset += size;
    }
    assert.deepEqual(samplesOf(Buffer.concat(parts)), samplesOf(whole), `chunking ${sizes}`);
  }
});

test("resampler: linear interpolation of a ramp stays on the ramp", async () => {
  const { Pcm16Resampler } = await load();
  const out = samplesOf(
    new Pcm16Resampler(24000, 16000).process(pcm(Array.from({ length: 300 }, (_, i) => i * 10)))
  );

  // Output n reads input position n * 1.5, so the ramp value is n * 15.
  out.slice(0, 50).forEach((value, n) => assert.equal(value, Math.round(n * 15)));
});

test("resampler: equal rates pass through and bad rates are refused", async () => {
  const { Pcm16Resampler } = await load();
  const input = pcm([1, -2, 3, -4]);

  assert.deepEqual(samplesOf(new Pcm16Resampler(16000, 16000).process(input)), [1, -2, 3, -4]);
  assert.throws(() => new Pcm16Resampler(0, 16000), /positive integers/);
  assert.throws(() => new Pcm16Resampler(24000.5, 16000), /positive integers/);
});
