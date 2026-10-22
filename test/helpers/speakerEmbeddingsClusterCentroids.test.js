const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const speakerModulePath = require.resolve("../../src/helpers/speakerEmbeddings");
const originalLoad = Module._load;
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return { app: { getPath: () => os.tmpdir(), isPackaged: false } };
  if (parent?.filename === speakerModulePath && request === "./onnxWorkerClient") return {};
  return originalLoad.call(this, request, parent, isMain);
};
const speakerEmbeddings = require(speakerModulePath);
Module._load = originalLoad;

const SAMPLE_RATE = 16000;

// A 16 kHz mono PCM16 WAV whose level changes every 10 s, so an embedding
// stub can tell which region of the file it was handed.
function writeWav(levels) {
  const samplesPerRegion = SAMPLE_RATE * 10;
  const data = Buffer.alloc(levels.length * samplesPerRegion * 2);
  levels.forEach((level, region) => {
    for (let i = 0; i < samplesPerRegion; i++) {
      data.writeInt16LE(Math.round(level * 32768), (region * samplesPerRegion + i) * 2);
    }
  });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);

  const wavPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ow-centroids-")), "a.wav");
  fs.writeFileSync(wavPath, Buffer.concat([header, data]));
  return wavPath;
}

const segments = [
  { start: 0, end: 4, speaker: "speaker_a" },
  { start: 4, end: 6.5, speaker: "speaker_a" },
  { start: 6.5, end: 8.5, speaker: "speaker_a" },
  { start: 8.4, end: 10, speaker: "speaker_a" },
  { start: 10, end: 12, speaker: "speaker_b" },
  { start: 12, end: 13, speaker: "speaker_c" },
];

let extracted;
let wavPath;

test.before(() => {
  wavPath = writeWav([0.25, 0.5]);
  speakerEmbeddings._extractEmbeddingFromSamples = async (samples) => {
    extracted.push(samples);
    return new Float32Array(512).fill(samples[0]);
  };
});

test.beforeEach(() => {
  extracted = [];
});

test.after(() => {
  fs.rmSync(path.dirname(wavPath), { recursive: true, force: true });
});

test("each cluster's voice comes from its three longest segments of 1.5 s or more", async () => {
  const centroids = await speakerEmbeddings.extractClusterCentroids(wavPath, segments);

  assert.deepEqual([...centroids.keys()], ["speaker_a", "speaker_b"]);
  assert.deepEqual(
    extracted.map((samples) => samples.length / SAMPLE_RATE),
    [4, 2.5, 2, 2]
  );
  assert.ok(Math.abs(centroids.get("speaker_a")[0] - 0.25) < 1e-4);
  assert.ok(Math.abs(centroids.get("speaker_b")[0] - 0.5) < 1e-4);
});

test("only the audio each voice uses is read, never the whole WAV", async () => {
  const originalReadFile = fs.readFileSync;
  const originalRead = fs.readSync;
  let wholeFileReads = 0;
  const reads = [];
  fs.readFileSync = (file, ...rest) => {
    if (file === wavPath) wholeFileReads += 1;
    return originalReadFile(file, ...rest);
  };
  fs.readSync = (fd, buffer, offset, length, position) => {
    reads.push(length);
    return originalRead(fd, buffer, offset, length, position);
  };
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let openFiles = 0;
  fs.openSync = (...args) => {
    openFiles += 1;
    return originalOpen(...args);
  };
  fs.closeSync = (fd) => {
    openFiles -= 1;
    return originalClose(fd);
  };
  try {
    await speakerEmbeddings.extractClusterCentroids(wavPath, segments);
  } finally {
    fs.readFileSync = originalReadFile;
    fs.readSync = originalRead;
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
  }
  assert.equal(wholeFileReads, 0);
  assert.equal(openFiles, 0);
  // The header, then one window per embedded segment.
  assert.deepEqual(
    reads.slice(1).map((bytes) => bytes / (SAMPLE_RATE * 2)),
    [4, 2.5, 2, 2]
  );
});

test("a segment longer than 8 s is embedded from its last 8 s", async () => {
  await speakerEmbeddings.extractClusterCentroids(wavPath, [
    { start: 0, end: 12, speaker: "speaker_a" },
  ]);

  const [samples] = extracted;
  assert.equal(samples.length / SAMPLE_RATE, 8);
  assert.ok(Math.abs(samples[0] - 0.25) < 1e-4);
  assert.ok(Math.abs(samples[samples.length - 1] - 0.5) < 1e-4);
});

test("a cluster whose voice fails leaves the other clusters' voices intact", async () => {
  const workingExtract = speakerEmbeddings._extractEmbeddingFromSamples;
  speakerEmbeddings._extractEmbeddingFromSamples = async (samples) => {
    if (Math.abs(samples[0] - 0.25) < 1e-4) throw new Error("onnx worker request timeout");
    return workingExtract(samples);
  };
  try {
    const centroids = await speakerEmbeddings.extractClusterCentroids(wavPath, segments);
    assert.deepEqual([...centroids.keys()], ["speaker_b"]);
  } finally {
    speakerEmbeddings._extractEmbeddingFromSamples = workingExtract;
  }
});

test("a cancel between clusters stops before the next cluster", async () => {
  const controller = new AbortController();
  const workingExtract = speakerEmbeddings._extractEmbeddingFromSamples;
  speakerEmbeddings._extractEmbeddingFromSamples = async (samples) => {
    controller.abort();
    return workingExtract(samples);
  };
  try {
    const centroids = await speakerEmbeddings.extractClusterCentroids(wavPath, segments, {
      signal: controller.signal,
    });
    assert.deepEqual([...centroids.keys()], ["speaker_a"]);
  } finally {
    speakerEmbeddings._extractEmbeddingFromSamples = workingExtract;
  }
});

test("a cancelled upload stops before extracting voices", async () => {
  const controller = new AbortController();
  controller.abort();

  const centroids = await speakerEmbeddings.extractClusterCentroids(wavPath, segments, {
    signal: controller.signal,
  });

  assert.equal(centroids.size, 0);
  assert.equal(extracted.length, 0);
});
