const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function renderSection(t, { isPaid, allowed }) {
  installBrowserGlobals(t);
  globalThis.__connectorsAllowed = allowed;
  t.after(() => {
    delete globalThis.__connectorsAllowed;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-connectors-section-test-",
    mockModules: {
      "/stores/policyStore": `
        export function usePolicyStore(selector) { return selector({}); }
      `,
      "/stores/policyRules": `
        export function isConnectorsAllowed() { return globalThis.__connectorsAllowed; }
      `,
      "/stores/settingsStore": `
        const state = { emailDraftTarget: "auto", setEmailDraftTarget() {} };
        export function useSettingsStore(selector) { return selector(state); }
      `,
      "/ui/select": `
        import React from "react";
        const Pass = ({ children }) => React.createElement("div", null, children);
        export const Select = Pass;
        export const SelectContent = Pass;
        export const SelectTrigger = Pass;
        export const SelectValue = () => null;
        export const SelectItem = ({ children }) => React.createElement("span", null, children);
      `,
      "/ui/button": `
        import React from "react";
        export function Button(props) { return React.createElement("button", props); }
      `,
    },
  });
  const { ConnectorsSection } = await vite.ssrLoadModule("/components/ConnectorsSection.tsx");
  return renderToStaticMarkup(createElement(ConnectorsSection, { isPaid, onUpgrade() {} }));
}

test("paid users choose where drafts open", async (t) => {
  const markup = await renderSection(t, { isPaid: true, allowed: true });
  assert.match(markup, /connectors\.email\.title/);
  assert.match(markup, /connectors\.email\.targets\.gmail/);
  assert.doesNotMatch(markup, /connectors\.upgrade/);
});

test("free users see an upgrade button instead of the picker", async (t) => {
  const markup = await renderSection(t, { isPaid: false, allowed: true });
  assert.match(markup, /connectors\.upgrade/);
  assert.doesNotMatch(markup, /connectors\.email\.targets\.gmail/);
  // Matches the API card pattern (IntegrationsView.tsx): the free-plan Upgrade
  // CTA is the primary/filled button, not outline.
  assert.doesNotMatch(markup, /variant="outline"/);
});

test("an org that turned connectors off sees why", async (t) => {
  const markup = await renderSection(t, { isPaid: true, allowed: false });
  assert.match(markup, /connectors\.policyOff/);
  assert.doesNotMatch(markup, /connectors\.email\.targets/);
});
