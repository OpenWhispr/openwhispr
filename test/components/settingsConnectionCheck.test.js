const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const source = (relativePath) =>
  fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");

async function load(t) {
  installBrowserGlobals(t);
  return createRendererServer(t, {
    cachePrefix: "openwhispr-settings-check-plumbing-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
      `,
    },
  });
}

test("a TabPanel hides its panel, and a nested one shows only while all are active", async (t) => {
  const vite = await load(t);
  const { TabPanel } = await vite.ssrLoadModule("/components/ui/TabPanel.tsx");
  const { usePanelVisible } = await vite.ssrLoadModule("/components/ui/usePanelVisible.ts");
  function Probe() {
    return React.createElement("i", null, usePanelVisible() ? "shown" : "held");
  }
  const nest = (outer, inner) =>
    renderToStaticMarkup(
      React.createElement(
        TabPanel,
        { active: outer },
        React.createElement(TabPanel, { active: inner }, React.createElement(Probe))
      )
    );
  assert.equal(renderToStaticMarkup(React.createElement(Probe)), "<i>shown</i>");
  assert.equal(nest(true, true), "<div><div><i>shown</i></div></div>");
  assert.equal(nest(true, false), '<div><div class="hidden"><i>held</i></div></div>');
  assert.equal(nest(false, true), '<div class="hidden"><div><i>held</i></div></div>');
});

test("the announcer is there from the start and says only what the check found", async (t) => {
  const vite = await load(t);
  const { ConnectionCheckAnnouncer } = await vite.ssrLoadModule(
    "/components/ui/ConnectionCheckAnnouncer.tsx"
  );
  const say = (announcement) =>
    renderToStaticMarkup(React.createElement(ConnectionCheckAnnouncer, { announcement }));
  assert.equal(
    say(null),
    '<div role="status" aria-live="polite" aria-atomic="true" class="sr-only"></div>'
  );
  for (const announcement of ["testing", "connected"]) {
    const spoken = `class="sr-only">onboarding.rehaul.provider.${announcement}</div>`;
    assert.ok(say(announcement).endsWith(spoken), announcement);
  }
});

test("Settings' sections and sub-tabs use the shared TabPanel", () => {
  const settings = source("src/components/SettingsPage.tsx");
  assert.match(settings, /import \{ TabPanel \} from "\.\/ui\/TabPanel";/);
  assert.doesNotMatch(settings, /function TabPanel\(/);
  assert.equal(settings.match(/<TabPanel active=/g).length, 10);
});
