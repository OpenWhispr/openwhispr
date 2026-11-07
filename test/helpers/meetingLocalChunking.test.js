const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LOCAL_CHUNK_LIMITS,
  bytesToMs,
  findLocalChunkCut,
  toLocalMeetingSegments,
} = require("../../src/helpers/meetingLocalChunking");

const SAMPLE_RATE = 24000;

// Builds 24 kHz PCM16 from [durationMs, amplitude] parts; a non-zero part is a
// 220 Hz tone standing in for speech, so its RMS is amplitude / sqrt(2).
const pcm = (...parts) => {
  const buffers = parts.map(([ms, amplitude]) => {
    const samples = Math.round((ms / 1000) * SAMPLE_RATE);
    const buffer = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
      const value = amplitude * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
      buffer.writeInt16LE(Math.round(value * 32767), i * 2);
    }
    return buffer;
  });
  return Buffer.concat(buffers);
};
const SPEECH = 0.3;
const cutMs = (buffer, options) => {
  const cut = findLocalChunkCut(buffer, options);
  return cut == null ? null : bytesToMs(cut);
};

test("keeps collecting below the minimum, even across a pause", () => {
  assert.equal(cutMs(pcm([2000, SPEECH], [600, 0], [1500, SPEECH])), null);
});

test("cuts in the middle of the first pause past the minimum", () => {
  const audio = pcm([2000, SPEECH], [600, 0], [3600, SPEECH], [600, 0], [1000, SPEECH]);
  // The pause at 2.0 s is before the minimum; the one at 6.2–6.8 s is cut at 6.5 s.
  assert.equal(cutMs(audio, { source: "system" }), 6500);
});

test("a pause still running at the end of the buffer is cut once it lasts 400 ms", () => {
  assert.equal(cutMs(pcm([5500, SPEECH], [300, 0])), null);
  assert.equal(cutMs(pcm([5500, SPEECH], [400, 0])), 5700);
});

test("a short closure inside speech is not a pause", () => {
  assert.equal(cutMs(pcm([3000, SPEECH], [200, 0], [3000, SPEECH])), null);
});

test("pauses are found under steady background noise", () => {
  const audio = pcm([3000, SPEECH], [3000, SPEECH], [600, 0.02], [500, SPEECH]);
  assert.equal(cutMs(audio), 6300);
});

test("speech without a pause waits for the limit, then cuts at its quietest window", () => {
  const { maxMs } = LOCAL_CHUNK_LIMITS.system;
  assert.equal(cutMs(pcm([maxMs - 100, SPEECH])), null);

  const audio = pcm([maxMs - 2000, SPEECH], [300, 0.1], [2500, SPEECH]);
  const cut = cutMs(audio, { source: "system" });
  assert.ok(cut >= maxMs - 2000 && cut <= maxMs - 1700, `cut at ${cut} ms`);
});

test("mic chunks have a shorter limit than system chunks", () => {
  const audio = pcm([LOCAL_CHUNK_LIMITS.mic.maxMs + 500, SPEECH]);
  assert.ok(cutMs(audio, { source: "mic" }) <= LOCAL_CHUNK_LIMITS.mic.maxMs);
  assert.equal(cutMs(audio, { source: "system" }), null);
});

test("the final flush takes everything within the limit, short or not", () => {
  assert.equal(cutMs(pcm([1200, SPEECH]), { final: true }), 1200);
  assert.equal(findLocalChunkCut(Buffer.alloc(0), { final: true }), null);

  const long = pcm([LOCAL_CHUNK_LIMITS.mic.maxMs + 4000, SPEECH]);
  assert.ok(cutMs(long, { source: "mic", final: true }) <= LOCAL_CHUNK_LIMITS.mic.maxMs);
});

test("digital silence is cut at the minimum rather than held to the limit", () => {
  assert.equal(cutMs(pcm([6000, 0])), LOCAL_CHUNK_LIMITS.system.minMs);
});

test("whisper segments each start at their own capture time", () => {
  const result = {
    text: "Hallo zusammen. Wie geht es euch?",
    segments: [
      { start: 0.4, end: 2.1, text: " Hallo zusammen." },
      { start: 2.6, end: 4.9, text: " Wie geht es euch?" },
      { start: 4.9, end: 5.0, text: " " },
    ],
  };
  assert.deepEqual(toLocalMeetingSegments(result, 10_000, 6000), [
    { text: "Hallo zusammen.", timestamp: 10_400, endTimestamp: 12_100 },
    { text: "Wie geht es euch?", timestamp: 12_600, endTimestamp: 14_900 },
  ]);
});

test("a segment end past the chunk is clamped, and an end before the start is dropped", () => {
  const result = {
    text: "a b",
    segments: [
      { start: 1, end: 9, text: "a" },
      { start: 2, end: 2, text: "b" },
    ],
  };
  assert.deepEqual(toLocalMeetingSegments(result, 1000, 5000), [
    { text: "a", timestamp: 2000, endTimestamp: 6000 },
    { text: "b", timestamp: 3000 },
  ]);
});

test("a segment offset outside the chunk is clamped to it", () => {
  const result = {
    text: "x y",
    segments: [
      { start: -1, text: "x" },
      { start: 30, text: "y" },
    ],
  };
  assert.deepEqual(toLocalMeetingSegments(result, 1000, 5000), [
    { text: "x", timestamp: 1000 },
    { text: "y", timestamp: 6000 },
  ]);
});

test("a result without segments stays one row at the chunk start", () => {
  assert.deepEqual(toLocalMeetingSegments({ text: " nur Text " }, 5000, 4000), [
    { text: "nur Text", timestamp: 5000 },
  ]);
  assert.deepEqual(toLocalMeetingSegments({ text: "  " }, 5000, 4000), []);
});
