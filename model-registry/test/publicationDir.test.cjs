const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { generateKeyPairSync } = require("node:crypto");
const { createPublication } = require("../lib/publication.cjs");
const { readPublicationDir, assertSucceeds } = require("../lib/publicationDir.cjs");
const { readCatalog } = require("../lib/catalog.cjs");

const keys = generateKeyPairSync("ed25519");
const trusted = { test: keys.publicKey.export({ type: "spki", format: "pem" }) };
const sign = (previous, privateKey = keys.privateKey) =>
  createPublication({
    data: readCatalog(),
    previous,
    rollback: true,
    sourceCommit: "a".repeat(40),
    headCommit: "a".repeat(40),
    testedClientContracts: ["c".repeat(64)],
    keyId: "test",
    privateKey,
  });

// A checkout of the published branch holding `count` versions.
function branch(count = 1) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-publication-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "ignore" });
  git("init", "--quiet");
  fs.mkdirSync(path.join(directory, "v2", "history"), { recursive: true });
  let previous;
  for (let version = 1; version <= count; version++) {
    const bytes = JSON.stringify(sign(previous)) + "\n";
    fs.writeFileSync(path.join(directory, "v2", "manifest.json"), bytes);
    fs.writeFileSync(path.join(directory, "v2", "history", `${version}.json`), bytes);
    previous = readPublicationDir(directory, trusted).manifest;
  }
  const commit = () => {
    git("add", "--all");
    git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "x");
  };
  commit();
  return { directory, commit };
}

test("a published branch is read only when signed and consistent with its history", () => {
  const { directory } = branch(2);
  assert.equal(readPublicationDir(directory, trusted).manifest.manifestVersion, 2);

  // The manifest put back to an earlier, validly signed version.
  fs.copyFileSync(
    path.join(directory, "v2", "history", "1.json"),
    path.join(directory, "v2", "manifest.json")
  );
  assert.throws(() => readPublicationDir(directory, trusted), /history ends at 2/);

  // And with the later history removed as well: the bytes no longer match a version.
  fs.rmSync(path.join(directory, "v2", "history", "2.json"));
  fs.rmSync(path.join(directory, "v2", "history", "1.json"));
  assert.throws(() => readPublicationDir(directory, trusted), /history ends at 0/);
});

test("a branch that published before cannot restart or repeat its numbering", () => {
  const { directory, commit } = branch(1);
  fs.rmSync(path.join(directory, "v2"), { recursive: true });
  commit();
  assert.throws(() => readPublicationDir(directory, trusted), /was removed/);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "registry-publication-"));
  assert.equal(readPublicationDir(empty, trusted), null);
});

test("a manifest signed by an unpinned key is refused", () => {
  const other = generateKeyPairSync("ed25519");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "registry-publication-"));
  fs.mkdirSync(path.join(directory, "v2", "history"), { recursive: true });
  const bytes = JSON.stringify(sign(undefined, other.privateKey)) + "\n";
  fs.writeFileSync(path.join(directory, "v2", "manifest.json"), bytes);
  fs.writeFileSync(path.join(directory, "v2", "history", "1.json"), bytes);
  assert.throws(() => readPublicationDir(directory, trusted), /Invalid registry signature/);
});

test("what an address serves never goes back, or changes under the same number", () => {
  const at = (manifestVersion, bytes) => ({ manifest: { manifestVersion }, bytes: Buffer.from(bytes) });
  assert.doesNotThrow(() => assertSucceeds(at(5, "b"), at(4, "a")));
  assert.doesNotThrow(() => assertSucceeds(at(4, "a"), at(4, "a")));
  assert.doesNotThrow(() => assertSucceeds(at(1, "a"), null));
  assert.throws(() => assertSucceeds(at(3, "c"), at(4, "a")), /newer version 4/);
  assert.throws(() => assertSucceeds(at(4, "b"), at(4, "a")), /numbered 4/);
  assert.throws(() => assertSucceeds(null, at(4, "a")), /no publication/);
});
