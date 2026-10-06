const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("i18n still loads under a window stub that lacks localStorage", async (t) => {
  installBrowserGlobals(t, { window: { localStorage: undefined } });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-i18n-import-test-",
  });

  const mod = await vite.ssrLoadModule("/i18n.ts");

  assert.equal(typeof mod.normalizeUiLanguage, "function");
  assert.ok(mod.SUPPORTED_UI_LANGUAGES.includes(mod.default.language));
});
