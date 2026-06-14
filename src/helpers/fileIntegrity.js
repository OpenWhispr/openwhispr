/**
 * File integrity verification for downloaded binaries and models.
 *
 * Supply-chain hardening: every binary OpenWhispr downloads is later EXECUTED
 * (whisper-server, llama-server, qdrant, sherpa-onnx, native listeners) or
 * loaded into an inference engine (GGUF/ONNX models). Without integrity
 * verification, a compromised upstream release — or a MITM after an unvalidated
 * redirect — could substitute a malicious payload that runs with the user's
 * privileges. Pinning a known-good SHA-256 per artifact closes that gap.
 *
 * Pure module: depends only on Node built-ins (crypto, fs), so it is unit
 * testable with `node --test` and reusable from both the runtime downloader
 * (src/helpers/downloadUtils.js) and the build-time one (scripts/lib).
 */
const crypto = require("crypto");
const fs = require("fs");

const SHA256_HEX = /^[a-f0-9]{64}$/i;

/**
 * @param {unknown} hash
 * @returns {boolean} true if `hash` is a syntactically valid SHA-256 hex digest.
 */
function isValidSha256(hash) {
  return typeof hash === "string" && SHA256_HEX.test(hash.trim());
}

/**
 * @param {string} hash
 * @returns {string} lowercased, trimmed hex digest.
 */
function normalizeHash(hash) {
  return String(hash).trim().toLowerCase();
}

/**
 * Constant-time comparison of two SHA-256 digests. Returns false (never throws)
 * if either side is not a valid digest.
 */
function hashesMatch(expected, actual) {
  if (!isValidSha256(expected) || !isValidSha256(actual)) return false;
  const a = Buffer.from(normalizeHash(expected), "hex");
  const b = Buffer.from(normalizeHash(actual), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Streams a file through SHA-256 (constant memory, handles multi-GB models).
 * @param {string} filePath
 * @returns {Promise<string>} lowercase hex digest.
 */
function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Verifies a file against an expected SHA-256.
 * @param {string} filePath
 * @param {string} expectedSha256 - hex digest (any case).
 * @returns {Promise<string>} the verified (actual) digest on success.
 * @throws {Error} code ERR_INVALID_CHECKSUM if `expectedSha256` is malformed;
 *                 code ERR_CHECKSUM_MISMATCH if the file does not match.
 */
async function verifyFileSha256(filePath, expectedSha256) {
  if (!isValidSha256(expectedSha256)) {
    throw Object.assign(new Error(`Invalid expected SHA-256: ${expectedSha256}`), {
      code: "ERR_INVALID_CHECKSUM",
    });
  }
  const actual = await computeFileSha256(filePath);
  if (!hashesMatch(expectedSha256, actual)) {
    throw Object.assign(
      new Error(
        `Checksum mismatch for ${filePath}: expected ${normalizeHash(expectedSha256)}, got ${actual}`
      ),
      { code: "ERR_CHECKSUM_MISMATCH", expected: normalizeHash(expectedSha256), actual }
    );
  }
  return actual;
}

module.exports = {
  isValidSha256,
  normalizeHash,
  hashesMatch,
  computeFileSha256,
  verifyFileSha256,
};
