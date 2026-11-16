const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bufferDurationMs,
  localBufferEntry,
  describeLocalChunk,
} = require("../../src/helpers/meetingLocalChunk");
const fx = require("./harness/pcmFixtures");

const T = 1_700_000_000_000;
const FRAME_SAMPLES = fx.SAMPLE_RATE / 10;

const silence = (durationMs) =>
  fx.toInt16Buffer(new Float32Array((durationMs / 1000) * fx.SAMPLE_RATE));
const tone = (durationMs) => fx.toInt16Buffer(fx.makeSine({ durationMs }));

const tone100ms = tone(100);
const tone1s = tone(1000);
const silence2s = silence(2000);
const silenceToneSilence = Buffer.concat([silence(2000), tone(1000), silence(2000)]);

function entriesFrom(buffer, startAt) {
  return fx
    .chunkBuffer(buffer, FRAME_SAMPLES)
    .map((slice, index) => ({ buffer: slice, startAt: startAt + index * 100 }));
}

test("bufferDurationMs reads PCM16 mono length at the sample rate", () => {
  assert.equal(bufferDurationMs(tone100ms), 100);
  assert.equal(bufferDurationMs(tone1s), 1000);
});

test("a capture time is used as the buffer's start", () => {
  assert.equal(localBufferEntry(tone100ms, { capturedAt: T }).startAt, T);
});

test("with no capture time the start is the receipt time minus the buffer's length", () => {
  assert.equal(localBufferEntry(tone100ms, { receivedAt: T }).startAt, T - 100);
  assert.equal(localBufferEntry(tone100ms, { now: () => T }).startAt, T - 100);
});

test("speech bounds are the first and last audible frames", () => {
  const chunk = describeLocalChunk(entriesFrom(silenceToneSilence, T));
  assert.equal(chunk.startAt, T);
  assert.equal(chunk.endAt, T + 5000);
  assert.equal(chunk.speechStartAt, T + 2000);
  assert.equal(chunk.speechEndAt, T + 3000);
  assert.equal(chunk.pcm.length, silenceToneSilence.length);
});

test("a hole in the chunk doesn't pull later speech earlier", () => {
  const entries = [...entriesFrom(tone1s, T), ...entriesFrom(tone1s, T + 4000)];
  const chunk = describeLocalChunk(entries);
  assert.equal(chunk.endAt, T + 5000);
  assert.equal(chunk.speechEndAt, T + 5000);
});

test("a chunk with nothing audible uses the chunk's own bounds", () => {
  const chunk = describeLocalChunk(entriesFrom(silence2s, T));
  assert.deepEqual([chunk.speechStartAt, chunk.speechEndAt], [T, T + 2000]);
});

test("an empty chunk is null", () => assert.equal(describeLocalChunk([]), null));
