const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Static render: effects never run, so useHotkeyModeInfo reports its defaults
// (Hold supported, no reason). The rows are driven by the slot's effective
// mode, which the store already carries; the hook only supplies the reason.
async function render(t, props) {
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-hotkey-gesture-rows-test-",
  });
  const mod = await vite.ssrLoadModule("/components/ui/HotkeyGestureRows.tsx");
  return renderToStaticMarkup(
    createElement(mod.HotkeyGestureRows, { slot: "dictation", hotkey: "Control+`", ...props })
  );
}

test("a Hold slot shows the hold row and the hands-free row with the slot's keycaps", async (t) => {
  const markup = await render(t, { mode: "push" });

  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.holdTitle/);
  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.holdDetail/);
  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.handsFreeTitle/);
  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.handsFreeDetail/);
  assert.match(markup, /common\.hold/);
  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.doublePress/);
  // Two rows × two keycaps (Control, `).
  assert.equal((markup.match(/<kbd/g) || []).length, 4);
  assert.doesNotMatch(markup, /tapOnlyTitle/);
});

test("a Tap slot shows one press-to-toggle row and says why Hold is unavailable", async (t) => {
  const markup = await render(t, { mode: "tap" });

  assert.match(markup, /settingsPage\.general\.hotkey\.gestures\.tapOnlyTitle/);
  assert.doesNotMatch(markup, /gestures\.holdTitle/);
  assert.doesNotMatch(markup, /gestures\.handsFreeTitle/);
  // No reason came back from main in a static render: the generic line.
  assert.match(markup, /windows\.pttUnavailable/);
  assert.equal((markup.match(/<kbd/g) || []).length, 2);
});

test("only the first hotkey of a list is rendered as keycaps", async (t) => {
  const markup = await render(t, { mode: "push", hotkey: "F8,Control+Shift+Space" });
  assert.equal((markup.match(/<kbd/g) || []).length, 2);
});

test("no rows without a hotkey", async (t) => {
  const markup = await render(t, { mode: "push", hotkey: "" });
  assert.equal(markup, "");
});
