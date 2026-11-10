const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/sherpaHotwords.js");

test("only measured models get a hotword score", async () => {
  const { getSherpaHotwordsScore } = await load();
  assert.equal(getSherpaHotwordsScore("orukeet-v0.1.0"), 2);
  for (const model of [
    "parakeet-tdt-0.6b-v3",
    "parakeet-unified-en-0.6b",
    "nemotron-speech-streaming-en-0.6b",
    "cohere-transcribe-03-2026",
    "unknown",
    "__proto__",
    "constructor",
  ]) {
    assert.equal(getSherpaHotwordsScore(model), null, model);
  }
});

test("hotwords keep dictionary order and split entries holding commas or lines", async () => {
  const { buildSherpaHotwords } = await load();
  assert.deepEqual(
    buildSherpaHotwords(["Schellhas van Kisfeld", "Grafana, Loki", "Line one\nLine two"]),
    ["Schellhas van Kisfeld", "Grafana", "Loki", "Line one", "Line two"]
  );
});

test("a word starting with ':' never reaches sherpa, which reads it as a score", async () => {
  const { buildSherpaHotwords } = await load();
  // "smile :)" made sherpa-onnx 1.13.8 abort at startup (stof: no conversion).
  assert.deepEqual(buildSherpaHotwords(["smile :)", "foo :9 bar", ":)", "Note:"]), [
    "smile",
    "foo bar",
    "Note:",
  ]);
});

test("hotwords collapse whitespace and drop case duplicates", async () => {
  const { buildSherpaHotwords } = await load();
  assert.deepEqual(buildSherpaHotwords(["  Open\tWhispr  ", "openwhispr", "", "OpenWhispr"]), [
    "Open Whispr",
    "openwhispr",
  ]);
  assert.deepEqual(buildSherpaHotwords([]), []);
});

test("hotwords stop at the cap, keeping the highest-priority words", async () => {
  const { buildSherpaHotwords, MAX_SHERPA_HOTWORDS } = await load();
  const words = Array.from({ length: MAX_SHERPA_HOTWORDS + 20 }, (_, index) => `Word${index}`);
  const hotwords = buildSherpaHotwords(words);
  assert.equal(hotwords.length, MAX_SHERPA_HOTWORDS);
  assert.equal(hotwords[0], "Word0");
  assert.equal(hotwords.at(-1), `Word${MAX_SHERPA_HOTWORDS - 1}`);
});
