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
  // Put back one version, consistently: the manifest and its history agree on version 1.
  const back = branch(2);
  fs.copyFileSync(
    path.join(back.directory, "v2", "history", "1.json"),
    path.join(back.directory, "v2", "manifest.json")
  );
  fs.rmSync(path.join(back.directory, "v2", "history", "2.json"));
  back.commit();
  assert.throws(() => readPublicationDir(back.directory, trusted), /lost or changed a published/);

  const { directory, commit } = branch(1);
  fs.rmSync(path.join(directory, "v2"), { recursive: true });
  commit();
  assert.throws(() => readPublicationDir(directory, trusted), /was removed/);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "registry-publication-"));
  assert.equal(readPublicationDir(empty, trusted), null);
});

test("a merge that puts back an earlier version is refused", () => {
  const { directory, commit } = branch(1);
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  const first = git("rev-parse", "HEAD");
  const previous = readPublicationDir(directory, trusted).manifest;
  const bytes = JSON.stringify(sign(previous)) + "\n";
  fs.writeFileSync(path.join(directory, "v2", "manifest.json"), bytes);
  fs.writeFileSync(path.join(directory, "v2", "history", "2.json"), bytes);
  commit();
  // A fast-forward of the branch whose tree is version 1 again. Path-limited history
  // follows the parent it matches, so the deleted version 2 is never looked at.
  const merge = git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit-tree", `${first}^{tree}`, "-p", "HEAD", "-p", first, "-m", "x");
  git("reset", "--quiet", "--hard", merge);
  assert.throws(() => readPublicationDir(directory, trusted), /merge commit/);
});

const symlinks = process.platform === "win32" && "creating symlinks needs privileges on Windows";

test("a published version replaced by a symlink is refused", { skip: symlinks }, () => {
  const { directory, commit } = branch(2);
  const first = path.join(directory, "v2", "history", "1.json");
  fs.rmSync(first);
  fs.symlinkSync("2.json", first);
  commit();
  assert.throws(() => readPublicationDir(directory, trusted), /lost or changed a published/);
});

test("a manifest that is a symlink is refused", { skip: symlinks }, () => {
  const { directory } = branch(2);
  const manifest = path.join(directory, "v2", "manifest.json");
  fs.rmSync(manifest);
  fs.symlinkSync(path.join("history", "2.json"), manifest);
  assert.throws(() => readPublicationDir(directory, trusted), /not a regular file/);
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
