const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/utils/formatBytes.ts");

test("zero and sub-kilobyte values format as Bytes", async () => {
  const { formatBytes } = await load();

  assert.equal(formatBytes(0), "0 Bytes");
  assert.equal(formatBytes(1), "1 Bytes");
  assert.equal(formatBytes(500), "500 Bytes");
});

test("unit boundaries land on whole units — model download sizes must read cleanly", async () => {
  const { formatBytes } = await load();

  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1024 * 1024), "1 MB");
  assert.equal(formatBytes(1024 * 1024 * 1024), "1 GB");
  assert.equal(formatBytes(1024 ** 4), "1 TB");
  assert.equal(formatBytes(5.5 * 1024 * 1024 * 1024), "5.5 GB");
});

test("fractional values respect the decimals parameter, with negatives clamped to zero", async () => {
  const { formatBytes } = await load();

  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1536, 0), "2 KB");
  assert.equal(formatBytes(1536, 1), "1.5 KB");
  assert.equal(formatBytes(1536, 3), "1.5 KB");
  assert.equal(formatBytes(1536, -1), "2 KB");
});
