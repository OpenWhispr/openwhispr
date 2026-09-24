const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  VOICE_MODELS,
  getVoiceModelStatus,
  getVoiceModelPaths,
  downloadVoiceModels,
} = require("../../src/helpers/voiceModels");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function touch(dir, relative) {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
}

// Fakes that "download" by creating files, so no network is touched.
function fakeDeps(dir, { skipFile } = {}) {
  const downloads = [];
  return {
    downloads,
    deps: {
      downloadFile: async (url, dest, { onProgress }) => {
        downloads.push(url);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, "archive-or-model");
        onProgress?.(5, 10);
      },
      extractTarBz2: async (_archive, destDir) => {
        const pocket = VOICE_MODELS.find((model) => model.id === "pocket-tts");
        for (const file of pocket.requiredFiles) {
          if (file !== skipFile) touch(destDir, file);
        }
      },
    },
  };
}

test("an empty directory needs all three models", (t) => {
  const status = getVoiceModelStatus(tempDir(t));
  assert.equal(status.ready, false);
  assert.deepEqual(status.missing, ["vad", "smart-turn", "pocket-tts"]);
  assert.ok(status.missingBytes > 100_000_000);
});

test("a partly extracted Pocket archive does not count as downloaded", (t) => {
  const dir = tempDir(t);
  touch(dir, "silero_vad.onnx");
  touch(dir, "smart-turn-v3.2-cpu.onnx");
  const pocket = VOICE_MODELS.find((model) => model.id === "pocket-tts");
  for (const file of pocket.requiredFiles.slice(0, -1)) touch(dir, file);

  const status = getVoiceModelStatus(dir);

  assert.equal(status.ready, false);
  assert.deepEqual(status.missing, ["pocket-tts"]);
});

test("download fetches only what is missing and reports ready", async (t) => {
  const dir = tempDir(t);
  touch(dir, "silero_vad.onnx");
  const { deps, downloads } = fakeDeps(dir);
  const progress = [];

  const status = await downloadVoiceModels({ modelsDir: dir, deps, onProgress: (p) => progress.push(p) });

  assert.equal(status.ready, true);
  assert.equal(downloads.length, 2);
  assert.ok(!downloads.some((url) => url.endsWith("silero_vad.onnx")));
  assert.deepEqual(progress[0], { model: "smart-turn", downloadedBytes: 5, totalBytes: 10 });
  assert.equal(fs.existsSync(path.join(dir, "sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2")), false);
});

test("an archive missing a required file fails loudly instead of reporting ready", async (t) => {
  const dir = tempDir(t);
  const { deps } = fakeDeps(dir, { skipFile: path.join("sherpa-onnx-pocket-tts-int8-2026-01-26", "vocab.json") });
  await assert.rejects(downloadVoiceModels({ modelsDir: dir, deps }), /pocket-tts.*vocab\.json/);
});

test("paths point inside the models directory", () => {
  const paths = getVoiceModelPaths("/models");
  assert.equal(paths.vad, path.join("/models", "silero_vad.onnx"));
  assert.equal(paths.smartTurn, path.join("/models", "smart-turn-v3.2-cpu.onnx"));
  assert.equal(
    paths.pocket.referenceVoiceWav,
    path.join("/models", "sherpa-onnx-pocket-tts-int8-2026-01-26", "test_wavs", "bria.wav")
  );
});
