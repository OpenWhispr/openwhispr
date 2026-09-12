const test = require("node:test");
const assert = require("node:assert/strict");

const ParakeetServerManager = require("../../src/helpers/parakeetServer");
const { computeFloat32RMS } = require("../../src/helpers/ffmpegUtils");

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
    const amplitude = span.silent ? 0 : (span.amplitude ?? 8000);
    for (let i = 0; i < span.seconds * SAMPLE_RATE; i++) {
      buf.writeInt16LE(i % 2 === 0 ? amplitude : -amplitude, offset);
      offset += 2;
    }
  }
  return buf;
}

function fakeWsServer(responses, { onCall } = {}) {
  const calls = [];
  return {
    calls,
    async start() {},
    async transcribe(samplesBuffer) {
      calls.push(samplesBuffer.length);
      const next = responses.shift();
      assert.ok(next, "unexpected extra transcribe call");
      onCall?.(calls.length);
      return { elapsed: 1, ...next };
    },
  };
}

function isAbortError(err) {
  assert.equal(err.name, "AbortError");
  return true;
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

test("quiet-but-audible audio is boosted to normal speech level before decode", async () => {
  const received = [];
  const fake = fakeWsServer([{ text: "hello" }], {
    onCall: () => {},
  });
  const innerTranscribe = fake.transcribe;
  fake.transcribe = async (samplesBuffer, ...rest) => {
    received.push(Buffer.from(samplesBuffer));
    return innerTranscribe(samplesBuffer, ...rest);
  };
  const manager = managerWith(fake);

  // 150/32768 ≈ 0.0046 RMS: inside the empty-decode band, above the silence gate.
  const result = await manager.transcribe(wavFromSeconds([{ seconds: 10, amplitude: 150 }]));

  assert.equal(result.text, "hello");
  const decodedRms = computeFloat32RMS(received[0]);
  assert.ok(
    Math.abs(decodedRms - 0.08) < 0.005,
    `expected decode-time RMS near the boost target, got ${decodedRms}`
  );
});

test("normal-level audio is decoded unmodified", async () => {
  const received = [];
  const fake = fakeWsServer([{ text: "hello" }]);
  const innerTranscribe = fake.transcribe;
  fake.transcribe = async (samplesBuffer, ...rest) => {
    received.push(Buffer.from(samplesBuffer));
    return innerTranscribe(samplesBuffer, ...rest);
  };
  const manager = managerWith(fake);

  await manager.transcribe(wavFromSeconds([{ seconds: 10 }]));

  const decodedRms = computeFloat32RMS(received[0]);
  assert.ok(
    Math.abs(decodedRms - 8000 / 32768) < 0.01,
    `expected decode-time RMS unchanged, got ${decodedRms}`
  );
});

test("boosted room noise still reads as silence in the segment loop", async () => {
  // 15s of quiet speech then 16s of sub-silence-gate noise. The boost lifts the
  // noise above the unscaled gate, so an unscaled cutoff would retry the empty
  // noise segments and falsely flag truncation.
  const fake = fakeWsServer([{ text: "alpha" }, { text: "" }, { text: "" }]);
  const manager = managerWith(fake);

  const result = await manager.transcribe(
    wavFromSeconds([
      { seconds: 15, amplitude: 150 },
      { seconds: 16, amplitude: 20 },
    ])
  );

  assert.equal(result.text, "alpha");
  assert.ok(!result.truncated, "boosted noise is not data loss");
  assert.equal(fake.calls.length, 3, "empty noise segments must not be retried");
});

test("a pre-aborted signal rejects before any decode is issued", async () => {
  const fake = fakeWsServer([]);
  const manager = managerWith(fake);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => manager.transcribe(wavFromSeconds([{ seconds: 10 }]), { signal: controller.signal }),
    isAbortError
  );
  assert.equal(fake.calls.length, 0);
});

test("an abort during the first segment stops the segment loop", async () => {
  const controller = new AbortController();
  const fake = fakeWsServer([{ text: "one" }, { text: "two" }, { text: "three" }], {
    onCall: () => controller.abort(),
  });
  const manager = managerWith(fake);

  await assert.rejects(
    () => manager.transcribe(wavFromSeconds([{ seconds: 31 }]), { signal: controller.signal }),
    isAbortError
  );
  assert.equal(fake.calls.length, 1, "no further segments may be scheduled after the abort");
});

test("an abort between an empty decode and its retry suppresses the retry", async () => {
  const controller = new AbortController();
  const fake = fakeWsServer([{ text: "" }, { text: "recovered" }], {
    onCall: () => controller.abort(),
  });
  const manager = managerWith(fake);

  await assert.rejects(
    () => manager.transcribe(wavFromSeconds([{ seconds: 10 }]), { signal: controller.signal }),
    isAbortError
  );
  assert.equal(fake.calls.length, 1, "the empty-decode retry must not run after a cancel");
});

test("transcribe without a signal is unchanged", async () => {
  const fake = fakeWsServer([{ text: "one" }, { text: "two" }, { text: "three" }]);
  const manager = managerWith(fake);

  const result = await manager.transcribe(wavFromSeconds([{ seconds: 31 }]));

  assert.equal(result.text, "one two three");
  assert.equal(fake.calls.length, 3);
});

test("cohere models segment at 30s and start the server with the resolved language", async () => {
  const fake = fakeWsServer([{ text: "one" }, { text: "two" }]);
  const startArgs = [];
  fake.start = async (...args) => {
    startArgs.push(args);
  };
  const manager = managerWith(fake);

  const result = await manager.transcribe(wavFromSeconds([{ seconds: 31 }]), {
    modelName: "cohere-transcribe-03-2026",
    language: "pl",
  });

  assert.equal(result.text, "one two");
  assert.deepEqual(fake.calls, [30 * SAMPLE_RATE * 4, 1 * SAMPLE_RATE * 4]);
  assert.equal(startArgs.length, 1);
  assert.equal(startArgs[0][0], "cohere-transcribe-03-2026");
  assert.equal(startArgs[0][2], "offline");
  assert.equal(startArgs[0][3], "pl");
});

test("cohere models fall back to English when the app language has no match", async () => {
  const fake = fakeWsServer([{ text: "hello" }]);
  const startArgs = [];
  fake.start = async (...args) => {
    startArgs.push(args);
  };
  const manager = managerWith(fake);

  await manager.transcribe(wavFromSeconds([{ seconds: 5 }]), {
    modelName: "cohere-transcribe-03-2026",
    language: "auto",
  });

  assert.equal(startArgs[0][3], "en");
});

test("transducer models start the server without a language", async () => {
  const fake = fakeWsServer([{ text: "hello" }]);
  const startArgs = [];
  fake.start = async (...args) => {
    startArgs.push(args);
  };
  const manager = managerWith(fake);

  await manager.transcribe(wavFromSeconds([{ seconds: 5 }]), { language: "pl" });

  assert.equal(startArgs[0][3], null);
});
