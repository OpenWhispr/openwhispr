const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/windowContext.ts");

test("a packaged dictation window ignores control in its install path", async (t) => {
  const originalWindow = globalThis.window;
  t.after(() => {
    globalThis.window = originalWindow;
  });
  globalThis.window = {
    location: {
      pathname:
        "/Users/controller/Applications/OpenWhispr.app/Contents/Resources/app.asar/src/dist/index.html",
      search: "",
    },
  };

  const { isControlPanelWindow, isDictationPanelWindow } = await load();

  assert.equal(isControlPanelWindow(), false);
  assert.equal(isDictationPanelWindow(), true);
});

test("only the explicit panel=true query selects the control panel", async (t) => {
  const originalWindow = globalThis.window;
  t.after(() => {
    globalThis.window = originalWindow;
  });
  globalThis.window = {
    location: {
      pathname: "/Applications/OpenWhispr.app/Contents/Resources/app.asar/src/dist/index.html",
      search: "?panel=true",
    },
  };

  const { isControlPanelWindow } = await load();

  assert.equal(isControlPanelWindow(), true);

  globalThis.window.location.search = "?notpanel=true";
  assert.equal(isControlPanelWindow(), false);

  globalThis.window.location.search = "?panel=trueish";
  assert.equal(isControlPanelWindow(), false);
});
