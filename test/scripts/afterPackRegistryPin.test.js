const test = require("node:test");
const assert = require("node:assert/strict");

const { verifyRegistryPinned } = require("../../scripts/afterPack");

const unpinned = { manifestVersion: 0, publicationCommit: null };
const pinned = { manifestVersion: 4, publicationCommit: "c".repeat(40) };
const builder = (...args) => ["node", "electron-builder", ...args];

test("a publishing build must bundle a pinned catalog", () => {
  for (const argv of [
    builder("--win", "--publish", "always"),
    builder("--mac", "-p", "onTag"),
    builder("--linux", "--publish=onTagOrDraft"),
  ])
    assert.throws(() => verifyRegistryPinned(argv, unpinned), /model-registry:pin-release/);
  assert.doesNotThrow(() => verifyRegistryPinned(builder("--win", "--publish", "always"), pinned));
});

test("a build that does not publish may bundle catalog version 0", () => {
  for (const argv of [builder("--win"), builder("--mac", "--publish", "never"), builder("--dir")])
    assert.doesNotThrow(() => verifyRegistryPinned(argv, unpinned));
});
