const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("hotkey inputs keep native listeners, validation, capture variants and rollback ownership", async (t) => {
  const { Window } = await import("happy-dom");
  const dom = new Window();
  const originalDocument = globalThis.document;
  const originalAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    globalThis.document = originalDocument;
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalAct;
    delete globalThis.__capturePlatform;
    delete globalThis.__hotkeyRows;
    await dom.happyDOM.close();
  });
  installBrowserGlobals(t);
  globalThis.window = dom;
  globalThis.document = dom.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const listening = [];
  const native = new Map();
  let registrations = 0;
  const subscribe = (name, callback) => {
    registrations++;
    native.set(name, callback);
    return () => native.delete(name);
  };
  dom.electronAPI = {
    setHotkeyListeningMode: async (enabled) => listening.push(enabled),
    onGlobeKeyPressed: (callback) => subscribe("down", callback),
    onGlobeKeyReleased: (callback) => subscribe("up", callback),
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-hotkey-inputs-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = key => key; export const useTranslation = () => ({t});`,
      "/utils/platform": `export const getPlatform = () => globalThis.__capturePlatform; export const getCachedPlatform = getPlatform;`,
      "./HotkeyInput": `export function HotkeyInput(props) {
        globalThis.__hotkeyRows.push(props);
        return null;
      }`,
      "../icons": `export const Plus = () => null; export const Trash2 = () => null; export const AlertTriangle = () => null;`,
    },
  });
  const { HotkeyInput } = await vite.ssrLoadModule("/components/ui/HotkeyInput.tsx");
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  // One non-darwin run covers linux/win32: identical chords, no Meta/Alt, no autoFocus; darwin keeps its GLOBE tail.
  for (const platform of ["linux", "darwin"]) {
    await t.test(`${platform}`, async () => {
      globalThis.__capturePlatform = platform;
      const values = [];
      const errors = [];
      const props = {
        value: "F7",
        variant: "default",
        onChange: (value) => values.push(value),
        onValidationError: (error) => errors.push(error),
        validate: () => null,
      };
      root = createRoot(container);
      const render = (extra = {}) =>
        React.act(async () =>
          root.render(React.createElement(HotkeyInput, { ...props, ...extra }))
        );
      await render();
      const surface = () => container.querySelector('[role="button"]');
      const focus = () => React.act(async () => surface().focus());
      const key = (type, init) =>
        React.act(async () =>
          surface().dispatchEvent(new dom.KeyboardEvent(type, { bubbles: true, ...init }))
        );
      await focus();
      const before = registrations;
      await key("keydown", { key: "Control", code: "ControlRight", ctrlKey: true });
      assert.equal(registrations, before, "modifier renders do not reconnect native listeners");
      await key("keyup", { key: "Control", code: "ControlRight" });
      assert.equal(values.at(-1), "RightControl");
      await focus();
      await key("keydown", { key: "F8", code: "F8", ctrlKey: true, shiftKey: true });
      assert.equal(values.at(-1), "Control+Shift+F8");
      await render({ validate: () => "blocked" });
      await focus();
      const count = values.length;
      await key("keydown", { key: "F9", code: "F9" });
      assert.equal(values.length, count);
      assert.equal(errors.at(-1), "blocked");
      await render({ disabled: true });
      await key("keydown", { key: "F10", code: "F10" });
      assert.equal(values.length, count);
      await render();
      await focus();
      await React.act(async () =>
        surface().dispatchEvent(new dom.MouseEvent("mousedown", { button: 3, bubbles: true }))
      );
      assert.equal(values.at(-1), "MouseButton4");
      if (platform === "darwin") {
        await focus();
        await React.act(async () => native.get("down")());
        await React.act(async () => native.get("up")());
        assert.equal(values.at(-1), "GLOBE");
      }
      await React.act(async () => root.unmount());
      root = null;
      assert.equal(native.size, 0);
      assert.equal(listening.at(-1), false);
    });
  }

  // HotkeyListInput's mocked props capture is reused; the folded rollback test needs no events.
  await t.test("optimistic list rows roll back on failure and adopt external changes", async () => {
    const { HotkeyListInput } = await vite.ssrLoadModule("/components/ui/HotkeyListInput.tsx");
    globalThis.__hotkeyRows = [];
    let settle;
    const onChange = () => new Promise((resolve) => (settle = resolve));
    let value = "F8";
    const listContainer = dom.document.createElement("div");
    dom.document.body.appendChild(listContainer);
    root = createRoot(listContainer);
    const renderList = async () => {
      globalThis.__hotkeyRows.length = 0;
      await React.act(async () =>
        root.render(React.createElement(HotkeyListInput, { value, onChange, onClear: onChange }))
      );
    };
    const row = () => globalThis.__hotkeyRows.at(-1);
    await renderList();
    assert.equal(row().value, "F8");
    await React.act(async () => row().onChange("F9"));
    assert.equal(row().value, "F9");
    await React.act(async () => settle(false));
    assert.equal(row().value, "F8");

    await React.act(async () => row().onClear());
    assert.equal(row().value, "");
    await React.act(async () => settle(false));
    assert.equal(row().value, "F8");

    await React.act(async () => row().onChange("F9"));
    value = "F10";
    await renderList();
    await React.act(async () => settle(false));
    assert.equal(row().value, "F10");
  });
});
