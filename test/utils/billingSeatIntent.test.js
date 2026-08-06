const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/billingSeatIntent.ts");

function installLocalStorage() {
  const values = new Map();
  const previous = global.localStorage;
  global.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  return {
    restore: () => {
      global.localStorage = previous;
    },
  };
}

test("readSeatIntent clears malformed stored JSON", async (t) => {
  const { restore } = installLocalStorage();
  t.after(restore);
  const { readSeatIntent } = await load();

  localStorage.setItem("settings.billingSeatIntent", "{not-json");

  assert.equal(readSeatIntent(), null);
  assert.equal(localStorage.getItem("settings.billingSeatIntent"), null);
});
