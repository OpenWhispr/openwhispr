// The v6 private split (database.js) retries on every launch until it lands. A later
// user_version step written as a bare `< N` would run on a device whose split failed, set N,
// and the split would never run again, so every step past 6 must also require version 6.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SPLIT_VERSION = 6;

// The user_version steps past the split whose condition doesn't also require it.
function stepsSkippingTheSplit(source) {
  const steps = source.matchAll(/^.*user_version", \{ simple: true \}\)\s*<\s*(\d+).*$/gm);
  return [...steps]
    .filter(([, version]) => Number(version) > SPLIT_VERSION)
    .filter(([line]) => !/user_version", \{ simple: true \}\)\s*>=\s*6\b/.test(line))
    .map(([line]) => line.trim());
}

test("the check flags a later step that doesn't wait for the split", () => {
  const unsafe = 'if (this.db.pragma("user_version", { simple: true }) < 7) {';
  const version = 'this.db.pragma("user_version", { simple: true })';
  const safe = `if (${version} >= 6 && ${version} < 7) {`;
  assert.deepEqual(stepsSkippingTheSplit(unsafe), [unsafe]);
  assert.deepEqual(stepsSkippingTheSplit(safe), []);
});

test("every user_version step past the private split waits for it", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/database.js"), "utf8");
  assert.deepEqual(stepsSkippingTheSplit(source), []);
});
