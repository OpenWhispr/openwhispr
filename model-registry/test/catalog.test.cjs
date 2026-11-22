const test = require("node:test");
const assert = require("node:assert/strict");
const seed = require("./seed.json");
const { readCatalog, validateCatalog, assertCompatibleCatalog } = require("../lib/catalog.cjs");

test("the split registry files compile to a valid catalog that keeps the shipping floor", () => {
  const catalog = readCatalog();
  assert.doesNotThrow(() => validateCatalog(catalog));
  assert.doesNotThrow(() => assertCompatibleCatalog(catalog, seed, { floor: seed }));
});

test("the floor is the desktop catalog the next release bundles", () => {
  for (const key of Object.keys(seed)) assert.ok(Object.hasOwn(readCatalog(), key), key);
});
