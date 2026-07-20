const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/utils/SecureCache.ts");

test("stores and retrieves values, returning undefined for missing keys", async () => {
  const { SecureCache } = await load();
  const cache = new SecureCache(60000);

  cache.set("key1", "value1");
  assert.equal(cache.get("key1"), "value1");
  assert.equal(cache.get("nonexistent"), undefined);
});

test("entries expire after the TTL and survive until just before it", async (t) => {
  const { SecureCache } = await load();
  t.mock.timers.enable({ apis: ["Date"] });

  const cache = new SecureCache(1000);
  cache.set("key1", "value1");

  t.mock.timers.tick(999);
  assert.equal(cache.get("key1"), "value1");

  t.mock.timers.tick(2);
  assert.equal(cache.get("key1"), undefined);
});

test("has() reflects liveness, not mere presence", async (t) => {
  const { SecureCache } = await load();
  t.mock.timers.enable({ apis: ["Date"] });

  const cache = new SecureCache(1000);
  cache.set("key1", "value1");
  assert.equal(cache.has("key1"), true);

  t.mock.timers.tick(1001);
  assert.equal(cache.has("key1"), false);
});

test("delete() removes entries and reports whether one existed", async () => {
  const { SecureCache } = await load();
  const cache = new SecureCache(60000);

  cache.set("key1", "value1");
  assert.equal(cache.delete("key1"), true);
  assert.equal(cache.get("key1"), undefined);
  assert.equal(cache.delete("nonexistent"), false);
});

test("clear() empties the cache", async () => {
  const { SecureCache } = await load();
  const cache = new SecureCache(60000);

  cache.set("a", "1");
  cache.set("b", "2");
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get("a"), undefined);
});

test("size counts expired entries until cleanup() sweeps them", async (t) => {
  const { SecureCache } = await load();
  t.mock.timers.enable({ apis: ["Date"] });

  const cache = new SecureCache(1000);
  cache.set("old", "1");

  t.mock.timers.tick(1001);
  assert.equal(cache.size, 1);

  cache.set("new", "2");
  cache.cleanup();

  assert.equal(cache.size, 1);
  assert.equal(cache.get("old"), undefined);
  assert.equal(cache.get("new"), "2");
});

test("startAutoCleanup sweeps on the interval and its stop function halts sweeping", async (t) => {
  const { SecureCache } = await load();
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });

  const cache = new SecureCache(500);
  cache.set("key1", "value1");

  const stop = cache.startAutoCleanup(1000);

  t.mock.timers.tick(600);
  assert.equal(cache.size, 1, "expired entry stays until the interval fires");

  t.mock.timers.tick(500);
  assert.equal(cache.size, 0, "interval sweep removes the expired entry");

  cache.set("key2", "value2");
  stop();
  t.mock.timers.tick(2000);
  assert.equal(cache.size, 1, "no sweeps after stop, even for expired entries");
});

test("setting an existing key overwrites its value", async () => {
  const { SecureCache } = await load();
  const cache = new SecureCache(60000);

  cache.set("key1", "first");
  cache.set("key1", "second");
  assert.equal(cache.get("key1"), "second");
});
