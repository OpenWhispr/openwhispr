const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseFfmpegDuration,
  isPcm16Mono16kWav,
  splitAudioFile,
  getFFmpegPath,
} = require("../../src/helpers/ffmpegUtils");
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

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ffmpegPath = getFFmpegPath();

// ffmpeg -i with no output exits non-zero; the stream listing is on stderr.
function streamsOf(file) {
  try {
    execFileSync(ffmpegPath, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    return error.stderr.toString();
  }
  return "";
}

// Without -vn ffmpeg maps the video track, encodes every frame to PNG and
// embeds one in the first piece (13.4 s vs 0.36 s for 2 min of 720p WebM). It
// also copies the file's tags into every piece: a user's titles, comments or a
// phone video's location would ride along to the provider, and a large tag
// makes an end-of-file sliver look like real audio.
test(
  "audio-only splitting keeps video frames and file tags out of every piece",
  { skip: !ffmpegPath && "no ffmpeg binary available" },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-split-audio-only-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = path.join(dir, "screen.mp4");
    execFileSync(ffmpegPath, [
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=2.5:size=64x64:rate=10",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2.5",
      "-c:v",
      "mpeg4",
      "-c:a",
      "aac",
      "-shortest",
      "-metadata",
      "title=Board meeting",
      "-metadata",
      `comment=${"x".repeat(10_000)}`,
      "-f",
      "mp4",
      "-y",
      source,
    ]);
    const out = path.join(dir, "pieces");
    fs.mkdirSync(out);

    const { chunkPaths } = await splitAudioFile(source, out, {
      segmentDuration: 1,
      audioOnly: true,
    });

    assert.ok(chunkPaths.length >= 2, `expected several pieces, got ${chunkPaths.length}`);
    for (const piece of chunkPaths) {
      const name = path.basename(piece);
      const info = streamsOf(piece);
      assert.doesNotMatch(info, /Video:/, `${name} carries a video frame`);
      assert.doesNotMatch(info, /Board meeting/, `${name} carries the file's tags`);
    }
  }
);
