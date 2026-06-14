const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  isValidSha256,
  hashesMatch,
  computeFileSha256,
  verifyFileSha256,
} = require("../../src/helpers/fileIntegrity");

// NIST FIPS 180-4 test vector: SHA-256("abc")
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

let counter = 0;
function tmpFileWith(contents) {
  const p = path.join(os.tmpdir(), `ow-integrity-${process.pid}-${counter++}.bin`);
  fs.writeFileSync(p, contents);
  return p;
}

test("isValidSha256 accepts a 64-char hex string (any case)", () => {
  assert.equal(isValidSha256(ABC_SHA256), true);
  assert.equal(isValidSha256(ABC_SHA256.toUpperCase()), true);
});

test("isValidSha256 rejects malformed input", () => {
  assert.equal(isValidSha256(""), false);
  assert.equal(isValidSha256("abc"), false);
  assert.equal(isValidSha256("g".repeat(64)), false); // non-hex char
  assert.equal(isValidSha256(ABC_SHA256 + "00"), false); // too long
  assert.equal(isValidSha256(ABC_SHA256.slice(0, 63)), false); // too short
  assert.equal(isValidSha256(null), false);
  assert.equal(isValidSha256(undefined), false);
  assert.equal(isValidSha256(12345), false);
});

test("hashesMatch is case-insensitive and rejects mismatches", () => {
  assert.equal(hashesMatch(ABC_SHA256, ABC_SHA256.toUpperCase()), true);
  assert.equal(hashesMatch(ABC_SHA256, "0".repeat(64)), false);
  assert.equal(hashesMatch("not-a-hash", ABC_SHA256), false);
  assert.equal(hashesMatch(ABC_SHA256, "short"), false);
});

test("computeFileSha256 matches the NIST 'abc' vector", async () => {
  const p = tmpFileWith("abc");
  try {
    assert.equal(await computeFileSha256(p), ABC_SHA256);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test("computeFileSha256 rejects on a missing file", async () => {
  await assert.rejects(() => computeFileSha256(path.join(os.tmpdir(), "ow-does-not-exist.bin")));
});

test("verifyFileSha256 resolves with the actual hash when it matches", async () => {
  const p = tmpFileWith("abc");
  try {
    assert.equal(await verifyFileSha256(p, ABC_SHA256.toUpperCase()), ABC_SHA256);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test("verifyFileSha256 throws ERR_CHECKSUM_MISMATCH on a wrong hash", async () => {
  const p = tmpFileWith("abc");
  try {
    await assert.rejects(
      () => verifyFileSha256(p, "0".repeat(64)),
      (err) => err.code === "ERR_CHECKSUM_MISMATCH"
    );
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test("verifyFileSha256 throws ERR_INVALID_CHECKSUM when the expected hash is malformed", async () => {
  const p = tmpFileWith("abc");
  try {
    await assert.rejects(
      () => verifyFileSha256(p, "nope"),
      (err) => err.code === "ERR_INVALID_CHECKSUM"
    );
  } finally {
    fs.rmSync(p, { force: true });
  }
});
