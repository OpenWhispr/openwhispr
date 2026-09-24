const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const { createElement } = React;
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");

const MOCKS = {
  "/stores/policyStore": `
    export function usePolicyStore(selector) { return selector({}); }
  `,
  "/stores/policyRules": `
    export function isConnectorsBlockedByOrg() { return globalThis.__connectorsBlocked; }
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
};

async function renderSection(t, { isPaid, blocked }) {
  installBrowserGlobals(t);
  globalThis.__connectorsBlocked = blocked;
  t.after(() => {
    delete globalThis.__connectorsBlocked;
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-connectors-section-test-",
    mockModules: MOCKS,
  });
  const { ConnectorsSection } = await vite.ssrLoadModule("/components/ConnectorsSection.tsx");
  return renderToStaticMarkup(createElement(ConnectorsSection, { isPaid, onUpgrade() {} }));
}

test("paid users choose where drafts open", async (t) => {
  const markup = await renderSection(t, { isPaid: true, blocked: false });
  assert.match(markup, /connectors\.email\.title/);
  assert.match(markup, /connectors\.email\.targets\.gmail/);
  assert.match(markup, /connectors\.email\.description/);
  assert.doesNotMatch(markup, /connectors\.viewPlans/);
});

test("free users see that a paid plan is required and a View Plans button", async (t) => {
  const markup = await renderSection(t, { isPaid: false, blocked: false });
  // Matches the API card pattern (IntegrationsView.tsx): the description says
  // a paid plan is required, and the CTA is the primary/filled button.
  assert.match(markup, /connectors\.email\.proRequired/);
  assert.doesNotMatch(markup, /connectors\.email\.description/);
  assert.match(markup, /connectors\.viewPlans/);
  assert.doesNotMatch(markup, /connectors\.email\.targets\.gmail/);
  assert.doesNotMatch(markup, /variant="outline"/);
});

test("an org that turned connectors off sees why", async (t) => {
  const markup = await renderSection(t, { isPaid: true, blocked: true });
  assert.match(markup, /connectors\.policyOff/);
  assert.doesNotMatch(markup, /connectors\.email\.targets/);
});

test("recent receipts name the recipient, or the action when a quit cut it short", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__connectorsBlocked;
  });
  globalThis.__connectorsBlocked = false;
  const row = (id, destinationLabel, state) => ({
    id,
    connector: "email",
    action: "draft",
    kind: "direct",
    destinationLabel,
    state,
    resultUrl: null,
    errorCode: null,
    createdAt: "2026-09-24 10:00:00",
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorRecentActions: async () => [row("a", "gabe@example.com", "failed"), row("b", null, "unknown")],
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-connectors-section-recent-test-",
    mockModules: MOCKS,
  });
  const { ConnectorsSection } = await vite.ssrLoadModule("/components/ConnectorsSection.tsx");
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () => root.render(createElement(ConnectorsSection, { isPaid: true, onUpgrade() {} })));

  const items = [];
  const walk = (node) => {
    if (node.tagName === "LI") items.push(node.textContent);
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(container);
  assert.equal(items.length, 2);
  assert.match(items[0], /^connectors\.recent\.actions\.email_draft/);
  assert.match(items[1], /^connectors\.recent\.unlabeledActions\.email_draft/);
});
