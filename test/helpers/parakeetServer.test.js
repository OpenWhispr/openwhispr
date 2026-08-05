const test = require("node:test");
const assert = require("node:assert/strict");

const ParakeetServerManager = require("../../src/helpers/parakeetServer");

const SAMPLE_RATE = 16000;
const SEGMENT_BYTES = 15 * SAMPLE_RATE * 4; // float32, mirrors MAX_SEGMENT_SECONDS

// Minimal 16kHz mono 16-bit WAV so _ensureWav uses the buffer as-is (no FFmpeg).
function wavFromSeconds(spans) {
  const totalSamples = spans.reduce((sum, span) => sum + span.seconds * SAMPLE_RATE, 0);
  const dataSize = totalSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  let offset = 44;
  for (const span of spans) {
    const amplitude = span.silent ? 0 : 8000;
    for (let i = 0; i < span.seconds * SAMPLE_RATE; i++) {
      buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, offset);
      offset += 2;
    }
  }
  return buf;
}

function fakeWsServer(responses) {
  const calls = [];
  return {
    calls,
    async start() {},
    async transcribe(samplesBuffer) {
      calls.push(samplesBuffer.length);
      const next = responses.shift();
      assert.ok(next, "unexpected extra transcribe call");
      return { elapsed: 1, ...next };
    },
  };
}

function managerWith(fake) {
  const manager = new ParakeetServerManager();
  manager.isModelDownloaded = () => true;
  manager.wsServer = fake;
  return manager;
}

test("audio at or under the 15s cap decodes in one request", async () => {
  const fake = fakeWsServer([{ text: "hello" }]);
  const manager = managerWith(fake);

  const result = await manager.transcribe(wavFromSeconds([{ seconds: 10 }]));

  assert.equal(result.text, "hello");
  assert.deepEqual(fake.calls, [10 * SAMPLE_RATE * 4]);
});

test("retries a single-request decode when audible audio decodes to empty", async () => {
  const fake = fakeWsServer([{ text: "" }, { text: "hello" }]);
  const manager = managerWith(fake);

  const result = await manager.transcribe(wavFromSeconds([{ seconds: 10 }]));

  assert.equal(result.text, "hello");
  assert.deepEqual(fake.calls, [10 * SAMPLE_RATE * 4, 10 * SAMPLE_RATE * 4]);
});

test("retries once when an audible segment decodes to empty text", async () => {
  const fake = fakeWsServer([{ text: "" }, { text: "one" }, { text: "two" }, { text: "three" }]);
  const manager = managerWith(fake);

  const result = await manager.transcribe(wavFromSeconds([{ seconds: 31 }]));

  assert.equal(result.text, "one two three");
  assert.ok(!result.truncated, "a recovered retry must not flag truncation");
  assert.deepEqual(fake.calls, [SEGMENT_BYTES, SEGMENT_BYTES, SEGMENT_BYTES, SAMPLE_RATE * 4]);
});

test("a truncated empty first attempt does not taint a successful retry", async () => {
  const fake = fakeWsServer([
    { text: "", truncated: true },
    { text: "one" },
    { text: "two" },
    { text: "three" },
  ]);
  const manager = managerWith(fake);

  const result = await manager.transcribe(wavFromSeconds([{ seconds: 31 }]));

  assert.equal(result.text, "one two three");
  assert.ok(!result.truncated, "the discarded attempt's truncation must not survive recovery");
});

test("flags truncation when an audible segment stays empty after the retry", async () => {
  const fake = fakeWsServer([{ text: "" }, { text: "" }, { text: "two" }, { text: "three" }]);
  const manager = managerWith(fake);

  const result = await manager.transcribe(wavFromSeconds([{ seconds: 31 }]));

  assert.equal(result.text, "two three");
  assert.equal(result.truncated, true);
});

test("a silent segment decoding to empty is not retried or flagged", async () => {
  const fake = fakeWsServer([{ text: "alpha" }, { text: "" }, { text: "omega" }]);
  const manager = managerWith(fake);

  const result = await manager.transcribe(
    wavFromSeconds([{ seconds: 15 }, { seconds: 15, silent: true }, { seconds: 1 }])
  );

  assert.equal(result.text, "alpha omega");
  assert.ok(!result.truncated, "silence is not data loss");
  assert.equal(fake.calls.length, 3);
});
