const test = require("node:test");
const assert = require("node:assert/strict");

const { parseFfmpegDuration, parseFfmpegProgressTime } = require("../../src/helpers/ffmpegUtils");

test("parseFfmpegDuration reads the input duration from ffmpeg output", () => {
  const stderr = "Input #0, mp3, from 'recording.mp3':\n  Duration: 01:13:00.25, start: 0.000000";
  assert.equal(parseFfmpegDuration(stderr), 4380.25);
});

test("parseFfmpegDuration returns null when ffmpeg reports no duration", () => {
  assert.equal(parseFfmpegDuration("Duration: N/A"), null);
  assert.equal(parseFfmpegDuration(""), null);
});

// Verbatim from `ffmpeg -i <MediaRecorder.webm> -f null -`. The header says
// "Duration: N/A" because MediaRecorder writes streaming WebM, so the elapsed
// time on the last progress line is the only measurement available.
const NULL_MUXER_STDERR = [
  "  Duration: N/A, start: 0.000000, bitrate: N/A",
  "  Stream #0:0(eng): Audio: opus, 48000 Hz, mono, fltp (default)",
  "size=       0kB time=00:00:00.00 bitrate=N/A speed=N/A    ",
  "size=N/A time=00:00:30.41 bitrate=N/A speed= 983x    ",
  "video:0kB audio:2858kB subtitle:0kB other streams:0kB global headers:0kB",
].join("\n");

test("parseFfmpegProgressTime takes the last elapsed time, not the first", () => {
  assert.equal(parseFfmpegProgressTime(NULL_MUXER_STDERR), 30.41);
  assert.equal(parseFfmpegDuration(NULL_MUXER_STDERR), null);
});

test("parseFfmpegProgressTime handles hours and returns null without progress", () => {
  assert.equal(parseFfmpegProgressTime("time=01:02:03.50"), 3723.5);
  assert.equal(parseFfmpegProgressTime("Duration: 00:00:10.00"), null);
  assert.equal(parseFfmpegProgressTime(""), null);
  assert.equal(parseFfmpegProgressTime(null), null);
});
