const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The harness renders i18n keys verbatim, so assertions match keys.
async function renderPasteToolsInfo(t, pasteToolsInfo) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-paste-tools-info-test-" });
  const { default: PasteToolsInfo } = await vite.ssrLoadModule("/components/ui/PasteToolsInfo.tsx");
  return renderToStaticMarkup(
    createElement(PasteToolsInfo, { pasteToolsInfo, isChecking: false, onCheck: () => {} })
  );
}

const SWAY = {
  platform: "linux",
  isWayland: true,
  isWlroots: true,
  hasWtype: true,
  available: true,
};

// Without wl-copy (#2621) a manual Ctrl+V in a Wayland app pastes stale text too, so
// the card never offers it as the way out.
test("a missing wl-clipboard is the only ask when paste tools are in place", async (t) => {
  const html = await renderPasteToolsInfo(t, { ...SWAY, wlCopyMissing: true });

  assert.match(html, /pasteToolsInfo\.wlClipboardTitle/);
  assert.match(html, /sudo apt install wl-clipboard/);
  assert.doesNotMatch(html, /pasteToolsInfo\.optionalEnableTitle/);
  assert.doesNotMatch(html, /pasteToolsInfo\.withoutToolPrefix/);
});

test("a missing wl-clipboard and a missing paste tool are asked for together", async (t) => {
  const html = await renderPasteToolsInfo(t, { ...SWAY, hasWtype: false, wlCopyMissing: true });

  assert.match(html, /sudo apt install wl-clipboard/);
  assert.match(html, /pasteToolsInfo\.optionalEnableTitle/);
  assert.match(html, /sudo apt install wtype/);
  assert.doesNotMatch(html, /pasteToolsInfo\.withoutToolPrefix/);
  assert.ok(
    html.indexOf("wl-clipboard") < html.indexOf("install wtype"),
    "wl-clipboard comes first"
  );
});

test("a missing paste tool alone keeps its card", async (t) => {
  const html = await renderPasteToolsInfo(t, { ...SWAY, hasWtype: false });

  assert.match(html, /sudo apt install wtype/);
  assert.match(html, /pasteToolsInfo\.withoutToolPrefix/);
  assert.doesNotMatch(html, /wl-clipboard/);
});
