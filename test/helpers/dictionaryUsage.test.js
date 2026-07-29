const test = require("node:test");
const assert = require("node:assert/strict");

const {
  countDictionaryTermOccurrences,
  MAX_USAGE_SCAN_CHARS,
} = require("../../src/helpers/dictionaryUsage.js");

test("counts a single occurrence at word boundaries", () => {
  const counts = countDictionaryTermOccurrences("Deploying with Kubernetes today", ["Kubernetes"]);
  assert.equal(counts.get("kubernetes"), 1);
});

test("matches at the very start and end of the text", () => {
  const counts = countDictionaryTermOccurrences("Qdrant rocks with Qdrant", ["Qdrant"]);
  assert.equal(counts.get("qdrant"), 2);
});

test("counting is case-insensitive and keyed by the lowercased term", () => {
  const counts = countDictionaryTermOccurrences("KUBERNETES and kubernetes", ["Kubernetes"]);
  assert.equal(counts.get("kubernetes"), 2);
});

test("counts every occurrence of a repeated term", () => {
  const counts = countDictionaryTermOccurrences("Vite builds fast, Vite reloads, Vite wins", [
    "Vite",
  ]);
  assert.equal(counts.get("vite"), 3);
});

test("does not count a term inside a longer word", () => {
  const counts = countDictionaryTermOccurrences(
    "Great views from the preview review of view_model",
    ["view"]
  );
  assert.equal(counts.get("view"), undefined);
});

test("counts a term adjacent to punctuation and possessives", () => {
  const counts = countDictionaryTermOccurrences("OpenWhispr's release (OpenWhispr!)", [
    "OpenWhispr",
  ]);
  assert.equal(counts.get("openwhispr"), 2);
});

test("regex metacharacters in terms match literally", () => {
  const counts = countDictionaryTermOccurrences("I use C++ and node.js daily", ["C++", "node.js"]);
  assert.equal(counts.get("c++"), 1);
  assert.equal(counts.get("node.js"), 1);
});

test("a dot in a term does not act as a wildcard", () => {
  const counts = countDictionaryTermOccurrences("nodexjs is not a thing", ["node.js"]);
  assert.equal(counts.get("node.js"), undefined);
});

test("multi-word term matches across irregular whitespace", () => {
  const counts = countDictionaryTermOccurrences("machine  learning\nrocks", ["machine learning"]);
  assert.equal(counts.get("machine learning"), 1);
});

test("longer term claims its span so a contained term is not double-counted", () => {
  const counts = countDictionaryTermOccurrences("machine learning rocks", [
    "machine learning",
    "learning",
  ]);
  assert.equal(counts.get("machine learning"), 1);
  assert.equal(counts.get("learning"), undefined);
});

test("contained term still counts where it appears on its own", () => {
  const counts = countDictionaryTermOccurrences("machine learning is learning", [
    "machine learning",
    "learning",
  ]);
  assert.equal(counts.get("machine learning"), 1);
  assert.equal(counts.get("learning"), 1);
});

test("accented term does not match its suffixed variant", () => {
  const counts = countDictionaryTermOccurrences("Un café ottimo, molti cafés", ["café"]);
  assert.equal(counts.get("café"), 1);
});

test("duplicate and case-variant input terms are counted once", () => {
  const counts = countDictionaryTermOccurrences("Qdrant is here", ["Qdrant", "qdrant", " Qdrant "]);
  assert.deepEqual([...counts.entries()], [["qdrant", 1]]);
});

test("returns an empty map for empty or non-string input", () => {
  assert.equal(countDictionaryTermOccurrences("", ["word"]).size, 0);
  assert.equal(countDictionaryTermOccurrences(null, ["word"]).size, 0);
  assert.equal(countDictionaryTermOccurrences("text", []).size, 0);
  assert.equal(countDictionaryTermOccurrences("text", [42, "", "   ", null]).size, 0);
  assert.equal(countDictionaryTermOccurrences("text", "not-an-array").size, 0);
});

test("occurrences beyond the scan cap are not counted", () => {
  const text = "x".repeat(MAX_USAGE_SCAN_CHARS) + " Kubernetes";
  const counts = countDictionaryTermOccurrences(text, ["Kubernetes"]);
  assert.equal(counts.get("kubernetes"), undefined);
});
