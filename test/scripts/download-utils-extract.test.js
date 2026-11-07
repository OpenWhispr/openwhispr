const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { extractArchive } = require("../../scripts/lib/download-utils.js");

function makeZipWithPayload(dir) {
  const payloadDir = path.join(dir, "payload");
  fs.mkdirSync(payloadDir);
  const file = path.join(payloadDir, "payload.txt");
  fs.writeFileSync(file, "SECRET\n");
  const zipPath = path.join(dir, "a.zip");
  execFileSync("zip", ["-j", "-q", zipPath, file]);
  return zipPath;
}

test("extractArchive keeps $ in dest path (no shell expansion)", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "download-utils-extract-"));
  try {
    const zipPath = makeZipWithPayload(base);
    // $HOME_bin is a single shell parameter; empty expansion would yield cache_/
    const dest = path.join(base, "cache_$HOME_bin");
    fs.mkdirSync(dest);

    await extractArchive(zipPath, dest);

    assert.deepEqual(fs.readdirSync(dest), ["payload.txt"]);
    assert.equal(fs.readFileSync(path.join(dest, "payload.txt"), "utf8"), "SECRET\n");
    assert.equal(fs.existsSync(path.join(base, "cache_")), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("extractArchive extracts into apostrophe dest paths", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "download-utils-apos-"));
  try {
    const zipPath = makeZipWithPayload(base);
    const dest = path.join(base, "O'Brien out");
    fs.mkdirSync(dest);

    await extractArchive(zipPath, dest);

    assert.deepEqual(fs.readdirSync(dest), ["payload.txt"]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
