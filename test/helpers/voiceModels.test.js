const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

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

const partialDirs = (dir) => fs.readdirSync(dir).filter((name) => name.includes(".partial-"));

const tts = VOICE_MODELS.find((model) => model.id === "supertonic-tts");

// A PID whose process has already exited.
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

// Fakes that "download" by creating files, so neither the network nor the real
// disk is consulted. A download's content is the model's pinned hash, and the fake
// hash reads it back, so it passes the checksum unless a test writes otherwise.
const pinnedHashOf = (url) => VOICE_MODELS.find((model) => model.url === url).sha256;

function fakeDeps(dir, { skipFile } = {}) {
  const downloads = [];
  const warnings = [];
  return {
    downloads,
    warnings,
    deps: {
      checkDiskSpace: async () => ({ ok: true, availableBytes: Infinity }),
      logger: { warn: (message, meta) => warnings.push({ message, meta }) },
      downloadFile: async (url, dest, { onProgress }) => {
        downloads.push(url);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, pinnedHashOf(url));
        onProgress?.(5, 10);
      },
      sha256File: async (filePath) => fs.readFileSync(filePath, "utf8"),
      extractTarBz2: async (_archive, destDir) => {
        for (const file of tts.requiredFiles) {
          if (file !== skipFile) touch(destDir, file);
        }
      },
    },
  };
}

test("an empty directory needs all three models", (t) => {
  const status = getVoiceModelStatus(tempDir(t));
  assert.equal(status.ready, false);
  assert.deepEqual(status.missing, ["vad", "smart-turn", "supertonic-tts"]);
  assert.ok(status.missingBytes > 100_000_000);
});

test("a partly extracted TTS archive does not count as downloaded", (t) => {
  const dir = tempDir(t);
  touch(dir, "silero_vad.onnx");
  touch(dir, "smart-turn-v3.2-cpu.onnx");
  for (const file of tts.requiredFiles.slice(0, -1)) touch(dir, file);

  const status = getVoiceModelStatus(dir);

  assert.equal(status.ready, false);
  assert.deepEqual(status.missing, ["supertonic-tts"]);
});

test("resuming a partly extracted TTS download finishes only that model", async (t) => {
  const dir = tempDir(t);
  touch(dir, "silero_vad.onnx");
  touch(dir, "smart-turn-v3.2-cpu.onnx");
  for (const file of tts.requiredFiles.slice(0, -1)) touch(dir, file);
  const { deps, downloads } = fakeDeps(dir);

  const status = await downloadVoiceModels({ modelsDir: dir, deps });

  assert.equal(downloads.length, 1);
  assert.ok(downloads[0].endsWith(`${tts.target}.tar.bz2`));
  assert.equal(status.ready, true);
  assert.deepEqual(status.missing, []);
  for (const file of tts.requiredFiles) {
    assert.ok(fs.existsSync(path.join(dir, file)), `expected ${file} to exist`);
  }
  assert.deepEqual(partialDirs(dir), []);
});

test("download fetches only what is missing and reports ready", async (t) => {
  const dir = tempDir(t);
  touch(dir, "silero_vad.onnx");
  const { deps, downloads } = fakeDeps(dir);
  const progress = [];

  const status = await downloadVoiceModels({
    modelsDir: dir,
    deps,
    onProgress: (p) => progress.push(p),
  });

  assert.equal(status.ready, true);
  assert.equal(downloads.length, 2);
  assert.ok(!downloads.some((url) => url.endsWith("silero_vad.onnx")));
  assert.deepEqual(progress[0], { model: "smart-turn", downloadedBytes: 5, totalBytes: 10 });
  assert.equal(
    fs.existsSync(path.join(dir, "sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2")),
    false
  );
});

test("an archive missing a required file fails loudly instead of reporting ready", async (t) => {
  const dir = tempDir(t);
  const { deps } = fakeDeps(dir, {
    skipFile: path.join("sherpa-onnx-supertonic-3-tts-int8-2026-05-11", "voice.bin"),
  });
  await assert.rejects(downloadVoiceModels({ modelsDir: dir, deps }), /supertonic-tts.*voice\.bin/);
  assert.equal(
    fs.existsSync(path.join(dir, "sherpa-onnx-supertonic-3-tts-int8-2026-05-11")),
    false
  );
});

test("an extraction interrupted mid-write leaves nothing that reads as ready", async (t) => {
  const dir = tempDir(t);
  const { deps } = fakeDeps(dir);
  deps.extractTarBz2 = async (_archive, destDir) => {
    // Every required file lands, the last one truncated, then extraction dies.
    for (const file of tts.requiredFiles) touch(destDir, file);
    throw new Error("tar: unexpected end of archive");
  };

  await assert.rejects(downloadVoiceModels({ modelsDir: dir, deps }), /unexpected end of archive/);

  assert.equal(fs.existsSync(path.join(dir, tts.target)), false);
  assert.deepEqual(getVoiceModelStatus(dir).missing, ["supertonic-tts"]);
  assert.deepEqual(partialDirs(dir), []);
  assert.equal(fs.existsSync(path.join(dir, `${tts.target}.tar.bz2`)), false);
});

test("the model is not visible until extraction has finished", async (t) => {
  const dir = tempDir(t);
  const { deps } = fakeDeps(dir);
  const extract = deps.extractTarBz2;
  let readyDuringExtraction = null;
  deps.extractTarBz2 = async (archive, destDir) => {
    await extract(archive, destDir);
    readyDuringExtraction = fs.existsSync(path.join(dir, tts.target));
  };

  const status = await downloadVoiceModels({ modelsDir: dir, deps });

  assert.equal(readyDuringExtraction, false);
  assert.equal(status.ready, true);
  assert.deepEqual(partialDirs(dir), []);
});

test("staging left by a crashed earlier run is cleared on the next download", async (t) => {
  const dir = tempDir(t);
  touch(dir, path.join(`.${tts.target}.partial-${deadPid()}-1`, tts.requiredFiles[0]));
  const { deps } = fakeDeps(dir);

  const status = await downloadVoiceModels({ modelsDir: dir, deps });

  assert.equal(status.ready, true);
  assert.deepEqual(partialDirs(dir), []);
});

test("staging owned by another live process is left alone", async (t) => {
  const dir = tempDir(t);
  // The parent (the test runner) stands in for a second instance mid-extraction.
  const liveStaging = `.${tts.target}.partial-${process.ppid}-1`;
  touch(dir, path.join(liveStaging, tts.requiredFiles[0]));
  const { deps } = fakeDeps(dir);

  const status = await downloadVoiceModels({ modelsDir: dir, deps });

  assert.equal(status.ready, true);
  assert.deepEqual(partialDirs(dir), [liveStaging]);
});

test("refuses to start without room for the archive and its extraction", async (t) => {
  const dir = tempDir(t);
  const { deps, downloads } = fakeDeps(dir);
  let requested = null;
  deps.checkDiskSpace = async (_dir, requiredBytes) => {
    requested = requiredBytes;
    return { ok: false, availableBytes: 50_000_000 };
  };

  await assert.rejects(downloadVoiceModels({ modelsDir: dir, deps }), /Not enough disk space/);

  assert.equal(downloads.length, 0);
  assert.ok(requested >= 3 * tts.approxBytes, `reserved only ${requested} bytes`);
});

test("a cleanup failure after the swap does not fail a finished install", async (t) => {
  const dir = tempDir(t);
  const { deps, warnings } = fakeDeps(dir);
  const rmSync = fs.rmSync;
  let failedOnce = false;
  t.mock.method(fs, "rmSync", (target, options) => {
    if (!failedOnce && target.includes(".partial-")) {
      failedOnce = true;
      throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
    }
    return rmSync(target, options);
  });

  const status = await downloadVoiceModels({ modelsDir: dir, deps });

  assert.equal(status.ready, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].meta.path, /\.partial-/);
});

test("a cancel during extraction discards it instead of reporting ready", async (t) => {
  const dir = tempDir(t);
  const { deps } = fakeDeps(dir);
  const signal = { aborted: false };
  const extract = deps.extractTarBz2;
  deps.extractTarBz2 = async (archive, destDir) => {
    await extract(archive, destDir);
    signal.aborted = true;
  };

  await assert.rejects(downloadVoiceModels({ modelsDir: dir, signal, deps }), (error) => {
    assert.equal(error.isAbort, true);
    return true;
  });

  assert.equal(fs.existsSync(path.join(dir, tts.target)), false);
  assert.deepEqual(getVoiceModelStatus(dir).missing, ["supertonic-tts"]);
  assert.deepEqual(partialDirs(dir), []);
  assert.equal(fs.existsSync(path.join(dir, `${tts.target}.tar.bz2`)), false);
});

test("paths point inside the models directory", () => {
  const paths = getVoiceModelPaths("/models");
  assert.equal(paths.vad, path.join("/models", "silero_vad.onnx"));
  assert.equal(paths.smartTurn, path.join("/models", "smart-turn-v3.2-cpu.onnx"));
  assert.equal(
    paths.supertonic.voiceStyle,
    path.join("/models", "sherpa-onnx-supertonic-3-tts-int8-2026-05-11", "voice.bin")
  );
});

test("a download that fails its pinned hash is discarded and never counts as ready", async (t) => {
  const dir = tempDir(t);
  const { deps } = fakeDeps(dir);
  const download = deps.downloadFile;
  deps.downloadFile = async (url, dest, options) => {
    await download(url, dest, options);
    // A rolling release tag swapped the file, or a proxy served an error page.
    if (url.endsWith("smart-turn-v3.2-cpu.onnx")) fs.writeFileSync(dest, "<html>error</html>");
  };

  await assert.rejects(downloadVoiceModels({ modelsDir: dir, deps }), /smart-turn: .*checksum/);

  const status = getVoiceModelStatus(dir);
  assert.ok(status.missing.includes("smart-turn"));
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.includes("smart-turn")),
    [],
    "nothing of the bad download is left behind"
  );
});

test("every voice model is pinned to a hash and none follows a moving branch", () => {
  for (const model of VOICE_MODELS) {
    assert.match(model.sha256, /^[0-9a-f]{64}$/, model.id);
    assert.doesNotMatch(model.url, /\/resolve\/main\//, model.id);
  }
});
