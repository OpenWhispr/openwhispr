const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("merges independent WebM recorder segments into one decodable timeline", async (t) => {
  const originalLoad = Module._load;
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === "electron") return { app: { isReady: () => false } };
    return originalLoad.call(this, request, parent, isMain);
  };

  let ffmpeg;
  try {
    ffmpeg = require("../../src/helpers/ffmpegUtils");
  } finally {
    Module._load = originalLoad;
  }
  const ffmpegPath = ffmpeg.getFFmpegPath();
  if (!ffmpegPath) {
    t.skip("FFmpeg is not available");
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-merge-test-"));
  try {
    const segments = [];
    for (let index = 0; index < 2; index += 1) {
      const segmentPath = path.join(tempDir, `segment-${index}.webm`);
      const generated = spawnSync(
        ffmpegPath,
        [
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=${440 + index * 220}:sample_rate=16000`,
          "-t",
          "0.25",
          "-c:a",
          "libopus",
          "-y",
          segmentPath,
        ],
        { windowsHide: true }
      );
      assert.equal(generated.status, 0, generated.stderr?.toString());
      segments.push({ buffer: fs.readFileSync(segmentPath), mimeType: "audio/webm" });
    }

    const merged = await ffmpeg.mergeAudioSegments(segments);
    const mergedPath = path.join(tempDir, "merged.webm");
    const wavPath = path.join(tempDir, "merged.wav");
    fs.writeFileSync(mergedPath, merged);
    await ffmpeg.convertToWav(mergedPath, wavPath);
    const samples = ffmpeg.wavToFloat32Samples(fs.readFileSync(wavPath));
    const durationSeconds = samples.length / 4 / 16000;
    assert.ok(durationSeconds > 0.4, `duration was ${durationSeconds}`);
    assert.ok(durationSeconds < 0.7, `duration was ${durationSeconds}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
