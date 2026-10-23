const nodeTest = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const { transcribeManagedAudioFile } = require("../../src/helpers/managedAudioFileTranscription");
const { getFFmpegPath } = require("../../src/helpers/ffmpegUtils");
const { silenceWav } = require("../../src/helpers/enterpriseAudioSetup");
const { getSafeTempDir } = require("../../src/helpers/safeTempDir");
const test = getFFmpegPath() ? nodeTest : nodeTest.skip;

function audio(durationSeconds = 3) {
  const buffer = Buffer.alloc(44 + Math.round(24000 * 2 * durationSeconds));
  silenceWav().copy(buffer, 0, 0, 44);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.writeUInt32LE(buffer.length - 44, 40);
  return buffer;
}
const temporaryFiles = () =>
  fs
    .readdirSync(getSafeTempDir())
    .filter((name) => /^enterprise-(buffer|chunks)-/.test(name))
    .sort();

for (const durationSeconds of [3, 3.05]) {
  test(`managed chunks keep a valid final clip for ${durationSeconds}s at an exact split boundary`, async () => {
    const before = temporaryFiles();
    const source = audio(durationSeconds);
    for (let frame = 24000 * 3; frame < (source.length - 44) / 2; frame++) {
      source.writeInt16LE(
        Math.round(12000 * Math.sin((2 * Math.PI * 600 * frame) / 24000)),
        44 + frame * 2
      );
    }
    const decoded = [];
    await transcribeManagedAudioFile({
      audioBuffer: source,
      fileName: "boundary.wav",
      maxUploadBytes: 20000,
      transcribe: async (buffer) => {
        assert.ok(buffer.length <= 20000);
        const pcm = execFileSync(
          getFFmpegPath(),
          ["-v", "error", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"],
          { input: buffer, windowsHide: true }
        );
        assert.ok(pcm.length >= 3200, `Azure rejects a ${pcm.length / 32000}s clip`);
        decoded.push(pcm);
        return `part-${decoded.length}`;
      },
    });
    assert.ok(decoded.length >= 3);
    if (durationSeconds > 3) assert.ok(decoded.at(-1).some((byte) => byte !== 0));
    assert.deepEqual(temporaryFiles(), before);
  });
}

test("oversized managed buffers use real ffmpeg chunks in order and clean temporary audio", async () => {
  const before = temporaryFiles();
  const sizes = [];
  const result = await transcribeManagedAudioFile({
    audioBuffer: audio(),
    fileName: "history.wav",
    maxUploadBytes: 20000,
    transcribe: async (buffer, name, type) => {
      assert.match(name, /\.mp3$/);
      assert.equal(type, "audio/mpeg");
      sizes.push(buffer.length);
      return `part-${sizes.length}`;
    },
  });
  assert.ok(sizes.length >= 3);
  assert.ok(sizes.every((size) => size <= 20000));
  assert.equal(result.text, sizes.map((_, index) => `part-${index + 1}`).join(" "));
  assert.deepEqual(temporaryFiles(), before);
});

test("canceling a managed history buffer stops queued chunks and releases temporary files", async () => {
  const before = temporaryFiles();
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    transcribeManagedAudioFile({
      audioBuffer: audio(),
      fileName: "dictation.wav",
      maxUploadBytes: 20000,
      signal: controller.signal,
      transcribe: async () => {
        calls++;
        controller.abort();
        return "retained";
      },
    }),
    { name: "AbortError" }
  );
  assert.equal(calls, 1);
  assert.deepEqual(temporaryFiles(), before);
});

test("managed chunk failures retain usable text and report the missing chunk", async () => {
  const before = temporaryFiles();
  let index = 0;
  const result = await transcribeManagedAudioFile({
    audioBuffer: audio(),
    fileName: "upload.wav",
    maxUploadBytes: 20000,
    onProgress: (progress) => {
      index = progress.chunksCompleted;
    },
    transcribe: async () => {
      if (index === 1)
        throw Object.assign(new Error("local provider unavailable"), { code: "SERVER_ERROR" });
      return `part-${index}`;
    },
  });
  assert.equal(result.failedChunks, 1);
  assert.match(result.text, /part-0/);
  assert.doesNotMatch(result.text, /part-1/);
  assert.deepEqual(temporaryFiles(), before);
});

test("the IPC job retains its original profile lifetime during preparation and between chunks", async () => {
  const ipcPath = path.join(__dirname, "../../src/helpers/ipcHandlers.js");
  const source = fs.readFileSync(ipcPath, "utf8");
  const start = source.indexOf("const transcribeManagedAudio = async");
  const end = source.indexOf("\n    ipcMain.handle(", start);
  assert.ok(start >= 0 && end > start);
  for (const rotationPoint of ["splitting", "between-chunks"]) {
    const before = temporaryFiles();
    let retirement = new AbortController();
    let submitted = 0;
    const rotate = () => {
      retirement.abort();
      retirement = new AbortController();
    };
    const run = vm.runInNewContext(`${source.slice(start, end)}\ntranscribeManagedAudio;`, {
      require: createRequire(ipcPath),
      AbortSignal,
      resolveEnterpriseRuntime: async () => ({
        enterprise: {
          audioProfile: { signal: retirement.signal, section: { maxUploadBytes: 20000 } },
        },
      }),
      executeManagedTranscription: async () => {
        submitted++;
        rotate();
        return "first chunk";
      },
    });
    await assert.rejects(
      run(
        {},
        { provider: "openai-compatible", context: {} },
        {
          audioBuffer: audio(),
          fileName: "history.wav",
          onProgress: ({ stage }) => {
            if (rotationPoint === "splitting" && stage === "splitting") rotate();
          },
        }
      ),
      { name: "AbortError" }
    );
    assert.equal(submitted, rotationPoint === "splitting" ? 0 : 1);
    assert.deepEqual(temporaryFiles(), before);
  }
});
