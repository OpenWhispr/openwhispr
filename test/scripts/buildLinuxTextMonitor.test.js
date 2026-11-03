const test = require("node:test");
const assert = require("node:assert/strict");

const {
  downloadedHash,
  isBinaryUpToDate,
  obtainSteps,
} = require("../../scripts/build-linux-text-monitor");

const state = (overrides) => ({
  binaryExists: true,
  sourceExists: true,
  savedHash: "abc",
  currentHash: "abc",
  canCompile: true,
  ...overrides,
});

test("a compiled binary is current only while its source hash matches", () => {
  assert.equal(isBinaryUpToDate(state()), true);
  assert.equal(isBinaryUpToDate(state({ currentHash: "def" })), false);
  assert.equal(isBinaryUpToDate(state({ binaryExists: false })), false);
});

// linux-text-monitor-v1.0.0 predated --probe-editable, yet every Linux build
// shipped it: the download ran first and was never checked against the source.
test("a downloaded binary is replaced as soon as the source can be compiled", () => {
  const downloaded = downloadedHash("abc");
  assert.equal(isBinaryUpToDate(state({ savedHash: downloaded })), false);
  assert.equal(isBinaryUpToDate(state({ savedHash: downloaded, canCompile: false })), true);
});

// Without headers the download is the only source, so a source change must
// fetch again: the newer release is the only way to pick up the change.
test("a downloaded binary is fetched again when the source changes", () => {
  assert.equal(
    isBinaryUpToDate(
      state({ savedHash: downloadedHash("abc"), currentHash: "def", canCompile: false })
    ),
    false
  );
});

test("compiling comes first, and CI never falls back to a release", () => {
  assert.deepEqual(obtainSteps({ canCompile: true, inCI: false }), ["compile", "download"]);
  assert.deepEqual(obtainSteps({ canCompile: true, inCI: true }), ["compile"]);
  assert.deepEqual(obtainSteps({ canCompile: false, inCI: true }), ["download"]);
  assert.deepEqual(obtainSteps({ canCompile: false, inCI: false }), ["download"]);
});

// The old check stamped the current hash onto a binary with none, so a stale
// download read as freshly built from then on.
test("a binary with no recorded hash is rebuilt", () => {
  assert.equal(isBinaryUpToDate(state({ savedHash: null })), false);
  assert.equal(isBinaryUpToDate(state({ savedHash: null, canCompile: false })), false);
  // A source that could not be hashed must not match a missing hash.
  assert.equal(isBinaryUpToDate(state({ savedHash: null, currentHash: null })), false);
});

test("a binary with no source beside it is kept", () => {
  assert.equal(isBinaryUpToDate(state({ sourceExists: false, savedHash: null })), true);
});
