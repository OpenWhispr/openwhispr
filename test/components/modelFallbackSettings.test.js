const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("fallback settings show an accessible toggle and ordered controls for each stage", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      cleanupFallbackEnabled: "true",
      cleanupFallbackModels: JSON.stringify([
        { provider: "openrouter", model: "vendor/one" },
        { provider: "openrouter", model: "vendor/two" },
      ]),
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "model-fallback-settings-ui-" });
  const { default: Component } = await vite.ssrLoadModule(
    "/components/settings/ModelFallbackSettings.tsx"
  );
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("en");
  const enabled = renderToStaticMarkup(createElement(Component, { stage: "cleanup" }));
  assert.match(enabled, /role="switch"/);
  assert.match(enabled, /aria-checked="true"/);
  assert.match(enabled, /aria-label="Move vendor\/one up"/);
  assert.match(enabled, /aria-label="Move vendor\/two down"/);
  assert.match(enabled, /aria-label="Remove vendor\/one"/);
  assert.ok(enabled.indexOf("vendor/one") < enabled.indexOf("vendor/two"));
  const independent = renderToStaticMarkup(createElement(Component, { stage: "transcription" }));
  assert.match(independent, /aria-checked="false"/);
  assert.doesNotMatch(independent, /vendor\/one/);
});
