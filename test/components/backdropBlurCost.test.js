const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Linux can composite on the CPU, where a backdrop blur is redrawn on every repaint above it
// (#2298). The harness renders i18n keys verbatim; the assertions only read classes.
async function loadModule(t, file, platform) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: `openwhispr-backdrop-blur-${platform}-test-`,
    mockModules: { "/utils/platform": `export const getCachedPlatform = () => "${platform}";` },
  });
  return vite.ssrLoadModule(file);
}

async function renderActionOverlay(t, platform) {
  const mod = await loadModule(t, "/components/notes/ActionProcessingOverlay.tsx", platform);
  return renderToStaticMarkup(
    createElement(mod.default, { state: "processing", actionName: "Generate Notes" })
  );
}

test("on Linux a running action draws no backdrop blur under its scanner animation", async (t) => {
  const html = await renderActionOverlay(t, "linux");

  assert.doesNotMatch(html, /backdrop-blur/);
  assert.match(html, /bg-background\/90/);
  // The card is opaque, so the unblurred scanner line can't run through its label.
  assert.match(html, /bg-background(?!\/)/);
  assert.doesNotMatch(html, /bg-accent\/6(?!\d)/);
});

test("on macOS a running action keeps its blur", async (t) => {
  const html = await renderActionOverlay(t, "darwin");

  assert.match(html, /backdrop-blur-md/);
  assert.match(html, /backdrop-blur-xl/);
});

test("a settings panel draws no backdrop blur on any platform", async (t) => {
  // It sits on a solid pane, so the blur showed nothing, and scrolling Settings redrew it
  // under every card on each frame.
  const mod = await loadModule(t, "/components/ui/SettingsSection.tsx", "darwin");
  const html = renderToStaticMarkup(createElement(mod.SettingsPanel, null, "row"));

  assert.doesNotMatch(html, /backdrop-blur/);
});
