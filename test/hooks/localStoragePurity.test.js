const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToString } = require("react-dom/server");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("real preference initialization is write-free; committed actions preserve batching, removals and failed writes", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const { storage } = installBrowserGlobals(t);
  const container = installHookDom(t);
  const vite = await createRendererServer(t);
  const { useLocalStorage } = await vite.ssrLoadModule("/hooks/useLocalStorage.ts");
  let rendering = false;
  let reject = false;
  const writes = [];
  const renderWork = [];
  const originalSet = storage.setItem;
  storage.setItem = (key, value) => {
    if (rendering) renderWork.push("write");
    if (reject) throw new Error("fake storage denial");
    writes.push([key, value]);
    originalSet(key, value);
  };
  const serialize = (value) => {
    if (rendering) renderWork.push("serialize");
    return String(value);
  };
  let preference;
  function Owner() {
    rendering = true;
    preference = useLocalStorage("autoLearnCorrections", true, {
      serialize,
      deserialize: (value) => value !== "false",
    });
    rendering = false;
    return null;
  }
  renderToString(React.createElement(Owner));
  assert.deepEqual(writes, []);
  assert.deepEqual(renderWork, []);
  root = createRoot(container);
  await React.act(async () =>
    root.render(React.createElement(React.StrictMode, null, React.createElement(Owner)))
  );
  assert.deepEqual(writes, [["autoLearnCorrections", "true"]]);
  assert.deepEqual(renderWork, []);
  let computations = 0;
  await React.act(async () => {
    preference[1]((value) => {
      computations++;
      return !value;
    });
    preference[1]((value) => {
      computations++;
      return !value;
    });
    preference[1](false);
  });
  assert.equal(computations, 2);
  assert.deepEqual(
    renderWork,
    [],
    "queued updates cannot serialize or persist during replayed render"
  );
  assert.equal(preference[0], false);
  assert.equal(storage.getItem("autoLearnCorrections"), "false");
  reject = true;
  const originalError = console.error;
  console.error = () => {};
  try {
    await React.act(async () => preference[1](true));
    assert.equal(preference[0], false);
    const originalRemove = storage.removeItem;
    storage.removeItem = () => {
      throw new Error("fake remove denial");
    };
    await React.act(async () => preference[2]());
    assert.equal(preference[0], false);
    assert.equal(storage.getItem("autoLearnCorrections"), "false");
    storage.removeItem = originalRemove;
    reject = false;
    await React.act(async () => preference[2]());
    assert.equal(preference[0], true);
    assert.equal(storage.getItem("autoLearnCorrections"), null);
    await React.act(async () =>
      root.render(React.createElement(React.StrictMode, null, React.createElement(Owner)))
    );
    assert.equal(
      storage.getItem("autoLearnCorrections"),
      null,
      "rerender cannot repersist a removed preference"
    );
  } finally {
    console.error = originalError;
  }
});

for (const [key, fallback, stored] of [
  ["settings.workspaceTab", "members", '"developer"'],
  ["micPermissionGranted", false, "true"],
  ["accessibilitySkipped", false, "true"],
]) {
  test(`${key} keeps existing, malformed and unreadable storage without render writes`, async (t) => {
    const { storage } = installBrowserGlobals(t, { initialStorage: { [key]: stored } });
    const vite = await createRendererServer(t);
    const { useLocalStorage } = await vite.ssrLoadModule("/hooks/useLocalStorage.ts");
    let result;
    function Owner() {
      result = useLocalStorage(key, fallback);
      return null;
    }
    storage.setItem = () => assert.fail("server render must not persist");
    renderToString(React.createElement(Owner));
    assert.equal(result[0], JSON.parse(stored));
    storage.getItem = () => "invalid JSON";
    renderToString(React.createElement(Owner));
    assert.equal(result[0], fallback);
    storage.getItem = () => {
      throw new Error("denied");
    };
    renderToString(React.createElement(Owner));
    assert.equal(result[0], fallback);
  });
}
