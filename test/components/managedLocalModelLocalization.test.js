const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const english = require("../../src/locales/en/translation.json");
const japanese = require("../../src/locales/ja/translation.json");

test("managed settings notice renders the active non-English locale", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-notice-i18n-",
    noExternal: ["react-i18next"],
    mockModules: {
      ProviderIcon: `export const ProviderIcon = () => null;`,
      "lucide-react": `import React from "react"; export const Lock = () => React.createElement("span");`,
      "/models/ModelRegistry": `
        export const getParakeetModelInfo = () => undefined;
        export const getWhisperModelInfo = () => undefined;
        export const modelRegistry = { getModel: () => undefined };
      `,
    },
  });
  const [{ default: i18n }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  await i18n.use(initReactI18next).init({
    lng: "ja",
    fallbackLng: "en",
    resources: { en: { translation: english }, ja: { translation: japanese } },
    interpolation: { escapeValue: false },
  });
  const { ManagedLocalModelNotice } = await vite.ssrLoadModule(
    "/components/settings/ManagedLocalModelNotice.tsx"
  );
  const markup = renderToStaticMarkup(
    React.createElement(ManagedLocalModelNotice, { selection: null })
  );
  assert.match(markup, /会社/);
  assert.doesNotMatch(markup, /Managed by your company/);
});
