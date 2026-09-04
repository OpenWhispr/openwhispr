const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/lib/reactiveLocalFlag.ts");

function installBrowserStubs() {
  const values = new Map();
  const listeners = new Map();
  const previous = { localStorage: global.localStorage, window: global.window };
  global.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  global.window = {
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name, listener) => {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
  };
  return () => {
    global.localStorage = previous.localStorage;
    global.window = previous.window;
  };
}

test("write and clear own the storage-plus-notify contract", async (t) => {
  const restore = installBrowserStubs();
  t.after(restore);
  const { createReactiveLocalFlag } = await load();
  const flag = createReactiveLocalFlag("feature");
  let changes = 0;
  const unsubscribe = flag.subscribe(() => changes++);

  flag.write(true);
  assert.equal(flag.read(), true);
  assert.equal(changes, 1);

  flag.write(true);
  assert.equal(changes, 1);

  flag.clear();
  assert.equal(flag.read(), false);
  assert.equal(changes, 2);

  flag.clear();
  assert.equal(changes, 2);
  unsubscribe();
});
