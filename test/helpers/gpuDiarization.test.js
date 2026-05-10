const test = require("node:test");
const assert = require("node:assert/strict");

const {
  cosineSimilarity,
  clusterEmbeddings,
  buildSegmentsFromWindows,
} = require("../../src/helpers/gpuDiarization");

test("cosineSimilarity returns 1 for identical vectors", () => {
  const v = [1, 0, 0, 1];
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1.0) < 0.001);
});

test("cosineSimilarity returns 0 for orthogonal vectors", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 0.001);
});

test("cosineSimilarity returns -1 for opposite vectors", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1.0) < 0.001);
});

test("clusterEmbeddings groups identical embeddings together", () => {
  const embeddings = [
    [1, 0, 0],
    [1, 0.01, 0],
    [0, 0, 1],
    [0, 0.01, 1],
  ];
  const labels = clusterEmbeddings(embeddings, { numSpeakers: 2 });
  assert.equal(labels[0], labels[1]);
  assert.equal(labels[2], labels[3]);
  assert.notEqual(labels[0], labels[2]);
});

test("clusterEmbeddings returns single label for one embedding", () => {
  const labels = clusterEmbeddings([[1, 0, 0]]);
  assert.equal(labels.length, 1);
  assert.equal(labels[0], 0);
});

test("clusterEmbeddings returns empty for no embeddings", () => {
  const labels = clusterEmbeddings([]);
  assert.equal(labels.length, 0);
});

test("clusterEmbeddings auto-detects speaker count with threshold", () => {
  const embeddings = [
    [1, 0, 0],
    [0.99, 0.01, 0],
    [0, 0, 1],
    [0, 0.01, 0.99],
  ];
  const labels = clusterEmbeddings(embeddings, { numSpeakers: -1, threshold: 0.5 });
  const unique = new Set(labels);
  assert.equal(unique.size, 2);
});

test("buildSegmentsFromWindows produces time-stamped speaker segments", () => {
  const numSpeakers = 2;
  const framesPerSpeaker = 20;
  const data = [];
  for (let i = 0; i < framesPerSpeaker; i++) data.push(0.9, 0.1);
  for (let i = 0; i < framesPerSpeaker; i++) data.push(0.1, 0.9);
  const numFrames = framesPerSpeaker * 2;
  const windows = [
    { offset: 0, data, dims: [1, numFrames, numSpeakers] },
  ];
  const segments = buildSegmentsFromWindows(windows, 16000);
  assert.ok(segments.length >= 1);
  assert.ok(segments[0].start >= 0);
  assert.ok(segments[0].end > segments[0].start);
  assert.ok(typeof segments[0].speakerIdx === "number");
});

test("buildSegmentsFromWindows returns empty for no windows", () => {
  const segments = buildSegmentsFromWindows([], 16000);
  assert.equal(segments.length, 0);
});

test("buildSegmentsFromWindows merges adjacent same-speaker frames", () => {
  const numFrames = 30;
  const numSpeakers = 1;
  const data = Array(numFrames).fill(0.9);
  const windows = [
    { offset: 0, data, dims: [1, numFrames, numSpeakers] },
  ];
  const segments = buildSegmentsFromWindows(windows, 16000);
  assert.equal(segments.length, 1);
});
