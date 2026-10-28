const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseFfmpegDuration,
  parseWavFormat,
  isPcm16Mono16kWav,
  wavToFloat32Samples,
} = require("../../src/helpers/ffmpegUtils");
const { wavHeader, pcm16Mono16kWav, insertWavChunk } = require("./harness/wavFixtures");

test("parseFfmpegDuration reads the input duration from ffmpeg output", () => {
  const stderr = "Input #0, mp3, from 'recording.mp3':\n  Duration: 01:13:00.25, start: 0.000000";
  assert.equal(parseFfmpegDuration(stderr), 4380.25);
});

test("parseFfmpegDuration returns null when ffmpeg reports no duration", () => {
  assert.equal(parseFfmpegDuration("Duration: N/A"), null);
  assert.equal(parseFfmpegDuration(""), null);
});

test("isPcm16Mono16kWav accepts only what the local engines decode as-is", () => {
  assert.equal(isPcm16Mono16kWav(wavHeader()), true);
  assert.equal(isPcm16Mono16kWav(wavHeader({ sampleRate: 48000 })), false);
  assert.equal(isPcm16Mono16kWav(wavHeader({ channels: 2 })), false);
  assert.equal(isPcm16Mono16kWav(wavHeader({ audioFormat: 3, bitsPerSample: 32 })), false);
  assert.equal(isPcm16Mono16kWav(Buffer.from("not a wav")), false);
});

const samples = [-32768, -16384, 0, 16384, 32767];
const wav = pcm16Mono16kWav(samples);
for (const [name, input] of [
  ["no metadata", wav],
  ["zero-length metadata", insertWavChunk(wav, "JUNK", Buffer.alloc(0), 12)],
  ["even-length metadata", insertWavChunk(wav, "JUNK", Buffer.from([1, 2]), 12)],
  ["odd-length metadata before fmt", insertWavChunk(wav, "JUNK", Buffer.from([42]), 12)],
  ["odd-length metadata before data", insertWavChunk(wav, "JUNK", Buffer.from([42]), 36)],
  ["three-byte metadata", insertWavChunk(wav, "JUNK", Buffer.from([1, 2, 3]), 36)],
  [
    "consecutive odd-length chunks",
    insertWavChunk(
      insertWavChunk(wav, "JUNK", Buffer.from([42]), 12),
      "JUNK",
      Buffer.from([7]),
      12
    ),
  ],
]) {
  test(`WAV chunk traversal preserves format and samples with ${name}`, () => {
    assert.deepEqual(parseWavFormat(input), {
      audioFormat: 1,
      channels: 1,
      sampleRate: 16000,
      bitsPerSample: 16,
    });
    assert.equal(isPcm16Mono16kWav(input), true);
    const decoded = wavToFloat32Samples(input);
    assert.equal(decoded.length, samples.length * 4);
    assert.deepEqual(
      samples.map((_, index) => decoded.readFloatLE(index * 4)),
      samples.map((sample) => sample / 32768)
    );
  });
}
