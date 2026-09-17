const test = require("node:test");
const assert = require("node:assert/strict");

const { parseFfmpegDuration, isPcm16Mono16kWav } = require("../../src/helpers/ffmpegUtils");
const { wavHeader } = require("./harness/wavFixtures");

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
