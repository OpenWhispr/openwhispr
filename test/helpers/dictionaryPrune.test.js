const test = require("node:test");
const assert = require("node:assert/strict");

const loadPrune = () => import("../../src/helpers/dictionaryPrune.js");

test("offers no candidates while no word has a recorded use", async () => {
  const { selectPruneCandidates } = await loadPrune();
  const entries = [
    { word: "alpha", usage_count: 0 },
    { word: "beta", usage_count: 0 },
  ];
  assert.deepEqual(selectPruneCandidates(entries), []);
});

test("offers only unused words once at least one word was used", async () => {
  const { selectPruneCandidates } = await loadPrune();
  const used = { word: "alpha", usage_count: 3 };
  const unused = { word: "beta", usage_count: 0 };
  assert.deepEqual(selectPruneCandidates([used, unused]), [unused]);
});

test("ignores malformed entries instead of offering them for removal", async () => {
  const { selectPruneCandidates } = await loadPrune();
  const entries = [
    { word: "alpha", usage_count: 1 },
    { word: "", usage_count: 0 },
    { word: "   ", usage_count: 0 },
    null,
    { usage_count: 0 },
    { word: "beta", usage_count: 0 },
  ];
  assert.deepEqual(selectPruneCandidates(entries), [{ word: "beta", usage_count: 0 }]);
});

test("treats a missing or non-numeric usage_count as unused", async () => {
  const { selectPruneCandidates } = await loadPrune();
  const entries = [
    { word: "alpha", usage_count: 2 },
    { word: "beta" },
    { word: "gamma", usage_count: "junk" },
  ];
  assert.deepEqual(selectPruneCandidates(entries), [
    { word: "beta" },
    { word: "gamma", usage_count: "junk" },
  ]);
});

test("tolerates non-array input", async () => {
  const { selectPruneCandidates } = await loadPrune();
  assert.deepEqual(selectPruneCandidates(null), []);
  assert.deepEqual(selectPruneCandidates(undefined), []);
});
