const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("disabled inference modes use native disabled buttons", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-inference-mode-selector-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({ t: (key) => key });`,
      "/components/ui/useSettingsLayout": `export const useSettingsLayout = () => ({ isCompact: false });`,
    },
  });
  const { InferenceModeSelector } = await vite.ssrLoadModule("/components/ui/SettingsSection.tsx");
  const markup = renderToStaticMarkup(
    React.createElement(InferenceModeSelector, {
      modes: [
        {
          id: "providers",
          disabled: true,
          label: "Cloud",
          description: "BYOK",
          icon: React.createElement("span"),
        },
      ],
      activeMode: "local",
      onSelect() {},
    })
  );
  assert.match(markup, /<button[^>]*disabled=""/);
});
