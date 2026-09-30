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

const LINEAR = {
  id: "linear",
  connected: true,
  configured: true,
  accountLabel: "Dana",
  workspaceLabel: "Acme",
  needsReconnect: false,
};
const DISCONNECTED = { ...LINEAR, connected: false, accountLabel: null, workspaceLabel: null };

// The Linear entry of CONNECTOR_ROWS in the shared login row, with the real
// status store loaded from `status`.
async function renderLinearRow(
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
    cachePrefix: "openwhispr-linear-connector-row-test-",
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
  const row = CONNECTOR_ROWS.find((spec) => spec.id === "linear");
  assert.ok(row, "CONNECTOR_ROWS has a Linear entry");
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(ConnectorLoginRow, { row, isPaid, blockedByOrg, onUpgrade() {} })
    )
  );
  // Let the status load from the mount effect commit.
  await React.act(async () => {});
  return { container, row, rows: CONNECTOR_ROWS };
}

test("the Linear row comes last and names the user and the workspace", async (t) => {
  const { container, row, rows } = await renderLinearRow(t, { status: LINEAR });

  assert.equal(rows.at(-1).id, "linear");
  assert.deepEqual(row.accountSummary(LINEAR), { account: "Dana", workspace: "Acme" });
  assert.deepEqual(row.accountSummary(DISCONNECTED), { account: "", workspace: "" });
  assert.match(container.textContent, /connectors\.linear\.title/);
  assert.match(container.textContent, /connectors\.linear\.connectedAs/);
  assert.equal(hasButton(container, "connectors.linear.disconnect"), true);
});

test("a build without a Linear client id shows no Linear row", async (t) => {
  const { container } = await renderLinearRow(t, {
    status: { ...DISCONNECTED, configured: false },
  });
  assert.equal(container.textContent, "");
});

test("Connect opens Linear's login and says when a permission was left out", async (t) => {
  const connects = [];
  const { container } = await renderLinearRow(t, {
    status: DISCONNECTED,
    electronAPI: {
      connectorConnect: async (connectorId) => {
        connects.push(connectorId);
        return { status: "failed", errorCode: "permission_not_granted" };
      },
    },
  });
  assert.match(container.textContent, /connectors\.linear\.description/);

  await React.act(async () => click(button(container, "connectors.linear.connect")));

  assert.deepEqual(connects, ["linear"]);
  assert.match(container.textContent, /connectors\.linear\.errors\.permission_not_granted/);
});

test("Disconnect removes the Linear login, not another connector's", async (t) => {
  const disconnects = [];
  const { container } = await renderLinearRow(t, {
    status: LINEAR,
    electronAPI: {
      connectorDisconnect: async (connectorId) => {
        disconnects.push(connectorId);
        return { status: "disconnected" };
      },
    },
  });

  await React.act(async () => click(button(container, "connectors.linear.disconnect")));

  assert.deepEqual(disconnects, ["linear"]);
});

test("a Linear login that needs reconnecting offers Reconnect and Disconnect", async (t) => {
  const { container } = await renderLinearRow(t, { status: { ...LINEAR, needsReconnect: true } });
  assert.match(container.textContent, /connectors\.linear\.needsReconnect/);
  assert.equal(hasButton(container, "connectors.linear.reconnect"), true);
  assert.equal(hasButton(container, "connectors.linear.disconnect"), true);
});

test("a free plan can still disconnect a Linear login it has", async (t) => {
  const connected = await renderLinearRow(t, { status: LINEAR, isPaid: false });
  assert.equal(hasButton(connected.container, "connectors.linear.disconnect"), true);
  assert.equal(hasButton(connected.container, "connectors.linear.connect"), false);
});

test("a free plan without a Linear login sees the upsell and no Connect", async (t) => {
  const { container } = await renderLinearRow(t, { status: DISCONNECTED, isPaid: false });
  assert.match(container.textContent, /connectors\.linear\.proRequired/);
  assert.equal(hasButton(container, "integrations.api.viewPlans"), true);
  assert.equal(hasButton(container, "connectors.linear.connect"), false);
});

test("with connectors turned off by the org, only Disconnect remains for a Linear login", async (t) => {
  const kept = await renderLinearRow(t, {
    status: { ...LINEAR, needsReconnect: true },
    blockedByOrg: true,
  });
  assert.equal(hasButton(kept.container, "connectors.linear.disconnect"), true);
  assert.equal(hasButton(kept.container, "connectors.linear.reconnect"), false);
});

test("with connectors turned off and no Linear login, the row is hidden", async (t) => {
  const { container } = await renderLinearRow(t, { status: DISCONNECTED, blockedByOrg: true });
  assert.equal(container.textContent, "");
});

test("each Linear tool has its own tool-step icon", async (t) => {
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-linear-tool-icons-test-" });
  const [{ toolIcons }, icons] = await Promise.all([
    vite.ssrLoadModule("/components/chat/toolIcons.ts"),
    vite.ssrLoadModule("/components/icons/index.ts"),
  ]);
  assert.equal(toolIcons.linear_search_issues, icons.Search);
  assert.equal(toolIcons.linear_create_issue, icons.CheckCircle);
  assert.equal(toolIcons.linear_comment, icons.MessageSquare);
});
