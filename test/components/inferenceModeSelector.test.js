const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("disabled inference modes render as native disabled buttons", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-inference-mode-selector-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t(key) { return key; } };
        }
      `,
      "/components/ui/useSettingsLayout": `
        export function useSettingsLayout() { return { isCompact: false }; }
      `,
    },
  });
  const { InferenceModeSelector } = await vite.ssrLoadModule(
    "/components/ui/SettingsSection.tsx"
  );
  const markup = renderToStaticMarkup(
    React.createElement(InferenceModeSelector, {
      modes: [
        {
          id: "providers",
          disabled: true,
          label: "Cloud providers",
          description: "Bring your own key",
          icon: React.createElement("span"),
        },
      ],
      activeMode: "local",
      onSelect: () => {},
    })
  );

  assert.match(markup, /<button[^>]*disabled=""/);
});
