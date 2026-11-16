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

async function renderActionOverlay(t, platform, state) {
  const mod = await loadModule(t, "/components/notes/ActionProcessingOverlay.tsx", platform);
  return renderToStaticMarkup(createElement(mod.default, { state, actionName: "Generate Notes" }));
}

function cardClass(html) {
  const match = html.match(/class="(relative flex flex-col[^"]*)"/);
  assert.ok(match, "the overlay renders its card");
  return match[1];
}

for (const [state, tint] of [
  ["processing", "accent"],
  ["success", "success"],
]) {
  test(`on Linux the ${state} overlay draws no backdrop blur and an opaque ${tint} card`, async (t) => {
    const html = await renderActionOverlay(t, "linux", state);
    const card = cardClass(html);

    assert.doesNotMatch(html, /backdrop-blur/);
    assert.match(html, /bg-background\/90/);
    // The tint is mixed into the background, so the unblurred scanner line can't run through
    // the label.
    assert.match(card, new RegExp(`bg-\\[color-mix\\(in_oklab,var\\(--color-${tint}\\)_6%`));
    assert.match(card, new RegExp(`dark:bg-\\[color-mix\\(in_oklab,var\\(--color-${tint}\\)_8%`));
    assert.doesNotMatch(card, new RegExp(`bg-${tint}/\\d`));
  });
}

test("on macOS a running action keeps its blur and translucent tints", async (t) => {
  const html = await renderActionOverlay(t, "darwin", "processing");
  const card = cardClass(html);

  assert.match(html, /bg-background\/60/);
  assert.match(html, /backdrop-blur-md/);
  assert.match(card, /bg-accent\/6(?!\d)/);
  assert.match(card, /backdrop-blur-xl/);
  assert.doesNotMatch(card, /color-mix/);
});

test("a settings panel draws no backdrop blur on any platform", async (t) => {
  // It sits on a solid pane, so the blur showed nothing, and scrolling Settings redrew it
  // under every card on each frame.
  const mod = await loadModule(t, "/components/ui/SettingsSection.tsx", "darwin");
  const html = renderToStaticMarkup(createElement(mod.SettingsPanel, null, "row"));

  assert.doesNotMatch(html, /backdrop-blur/);
});

test("the language picker's trigger draws no backdrop blur on any platform", async (t) => {
  const mod = await loadModule(t, "/components/ui/LanguageSelector.tsx", "darwin");
  const html = renderToStaticMarkup(
    createElement(mod.default, {
      value: "en",
      onChange: () => {},
      options: [{ value: "en", label: "English", flag: "🇺🇸" }],
    })
  );

  assert.match(html, /English/);
  assert.doesNotMatch(html, /backdrop-blur/);
});
