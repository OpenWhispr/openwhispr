const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function render(t, props) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-hotkey-keycaps-test-" });
  const mod = await vite.ssrLoadModule("/components/ui/HotkeyKeycaps.tsx");
  return renderToStaticMarkup(createElement(mod.HotkeyKeycaps, props));
}

test("one keycap per hotkey part, joined by plus signs", async (t) => {
  const markup = await render(t, { hotkey: "Control+Shift+Space" });
  assert.equal((markup.match(/<kbd/g) || []).length, 3);
  assert.equal((markup.match(/ \+ /g) || []).length, 2);
});

test("a single key renders one keycap and no joiner", async (t) => {
  const markup = await render(t, { hotkey: "F8" });
  assert.equal((markup.match(/<kbd/g) || []).length, 1);
  assert.doesNotMatch(markup, / \+ /);
});
