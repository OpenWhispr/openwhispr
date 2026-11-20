const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

function click(element) {
  element.dispatchEvent({
    type: "click",
    bubbles: true,
    button: 0,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.cancelBubble = true;
    },
  });
}

// No i18next instance is initialized, so text renders as its keys.
function findButton(root, label) {
  return findElement(
    root,
    (element) => element.tagName === "BUTTON" && element.textContent === label
  );
}

// A boolean, so a failed assertion never tries to print a DOM node.
function hasButton(root, label) {
  return Boolean(findButton(root, label));
}

function button(root, label) {
  const found = findButton(root, label);
  assert.ok(found, `button ${label} is rendered`);
  return found;
}

const SALESFORCE = {
  id: "salesforce",
  connected: true,
  configured: true,
  accountLabel: "Dana",
  workspaceLabel: "Acme",
  needsReconnect: false,
};
const DISCONNECTED = {
  ...SALESFORCE,
  connected: false,
  accountLabel: null,
  workspaceLabel: null,
};

// The Salesforce entry of CONNECTOR_ROWS in the shared login row, with the real
// status store loaded from `status`.
async function renderSalesforceRow(
  t,
  { status, isPaid = true, blockedByOrg = false, electronAPI = {} } = {}
) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorStatus: async () => (status ? [status] : []),
        onConnectorStatusChanged: () => () => {},
        connectorRecentActions: async () => [],
        ...electronAPI,
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-salesforce-connector-row-test-",
    mockModules: {
      "/ui/button": `
        import React from "react";
        export function Button(props) { return React.createElement("button", props); }
      `,
      "/ui/SettingsSection": `
        import React from "react";
        export const SettingsPanelRow = ({ children }) => React.createElement("div", null, children);
        export const SettingsPanel = SettingsPanelRow;
      `,
    },
  });
  const [{ CONNECTOR_ROWS }, { ConnectorLoginRow }] = await Promise.all([
    vite.ssrLoadModule("/components/connectors/connectorRows.tsx"),
    vite.ssrLoadModule("/components/connectors/ConnectorLoginRow.tsx"),
  ]);
  const row = CONNECTOR_ROWS.find((spec) => spec.id === "salesforce");
  assert.ok(row, "CONNECTOR_ROWS has a Salesforce entry");
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () =>
    root.render(React.createElement(ConnectorLoginRow, { row, isPaid, blockedByOrg }))
  );
  // Let the status load from the mount effect commit.
  await React.act(async () => {});
  return { container, row, rows: CONNECTOR_ROWS };
}

// React's change event reads the new value from the element, then an input event.
function type(element, value) {
  if (element.tagName === "INPUT" && !element.type) element.type = "text";
  element.value = value;
  element.dispatchEvent({
    type: "input",
    bubbles: true,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {},
    stopPropagation() {},
  });
}

test("Connect signs in at login.salesforce.com unless a sandbox or company domain is typed", async (t) => {
  const connects = [];
  const { container } = await renderSalesforceRow(t, {
    status: DISCONNECTED,
    electronAPI: {
      connectorConnect: async (connectorId, options) => {
        connects.push([connectorId, options]);
        return { status: "failed", errorCode: "invalid_login_domain" };
      },
    },
  });
  await React.act(async () => click(button(container, "connectors.salesforce.connect")));
  assert.deepEqual(connects, [["salesforce", undefined]]);
  assert.match(container.textContent, /connectors\.salesforce\.errors\.invalid_login_domain/);

  await React.act(async () => click(button(container, "connectors.salesforce.loginDomain.toggle")));
  const input = findElement(
    container,
    (element) =>
      element.tagName === "INPUT" &&
      element.getAttribute("aria-label") === "connectors.salesforce.loginDomain.label"
  );
  assert.ok(input);
  await React.act(async () => type(input, " test.salesforce.com "));
  await React.act(async () => click(button(container, "connectors.salesforce.connect")));
  assert.deepEqual(connects[1], ["salesforce", { loginDomain: "test.salesforce.com" }]);
});

test("a connected Salesforce login offers no sign-in domain", async (t) => {
  const { container } = await renderSalesforceRow(t, { status: SALESFORCE });
  assert.equal(hasButton(container, "connectors.salesforce.loginDomain.toggle"), false);
});

test("Reconnect signs in where the login was made unless a moved domain is typed", async (t) => {
  const connects = [];
  const { container } = await renderSalesforceRow(t, {
    status: { ...SALESFORCE, needsReconnect: true },
    electronAPI: {
      connectorConnect: async (connectorId, options) => {
        connects.push([connectorId, options]);
        return { status: "connected" };
      },
    },
  });
  await React.act(async () => click(button(container, "connectors.salesforce.reconnect")));
  assert.deepEqual(connects, [["salesforce", undefined]]);

  await React.act(async () => click(button(container, "connectors.salesforce.loginDomain.toggle")));
  // "Leave empty for production" isn't true here: empty keeps the saved host.
  assert.doesNotMatch(container.textContent, /connectors\.salesforce\.loginDomain\.hint/);
  const input = findElement(
    container,
    (element) =>
      element.tagName === "INPUT" &&
      element.getAttribute("aria-label") === "connectors.salesforce.loginDomain.label"
  );
  assert.ok(input);
  await React.act(async () => type(input, "renamed.my.salesforce.com"));
  await React.act(async () => click(button(container, "connectors.salesforce.reconnect")));
  assert.deepEqual(connects[1], ["salesforce", { loginDomain: "renamed.my.salesforce.com" }]);
});
