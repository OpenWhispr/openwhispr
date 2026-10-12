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

async function loadRows(t, electronAPI = {}) {
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        connectorStatus: async () => [],
        onConnectorStatusChanged: () => () => {},
        connectorRecentActions: async () => [],
        ...electronAPI,
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-connector-rows-test-",
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
  const [rows, { ConnectorLoginRow }] = await Promise.all([
    vite.ssrLoadModule("/components/connectors/connectorRows.tsx"),
    vite.ssrLoadModule("/components/connectors/ConnectorLoginRow.tsx"),
  ]);
  return { container, rows, ConnectorLoginRow };
}

test("the shipped rows are Gmail, Slack, Linear then GitHub, with their account summaries", async (t) => {
  const { rows } = await loadRows(t);
  const status = { accountLabel: "chad", workspaceLabel: "Acme" };

  assert.deepEqual(
    rows.CONNECTOR_ROWS.map((row) => row.id),
    ["gmail", "slack", "linear", "github"]
  );
  assert.deepEqual(rows.CONNECTOR_ROWS[0].accountSummary(status), { account: "chad" });
  assert.deepEqual(rows.CONNECTOR_ROWS[1].accountSummary(status), {
    account: "chad",
    workspace: "Acme",
  });
  assert.deepEqual(rows.accountLabelSummary({ accountLabel: null }), { account: "" });
});

test("a row's connecting detail shows only while Connect is in progress", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  let finishConnect;
  const { container, rows, ConnectorLoginRow } = await loadRows(t, {
    connectorConnect: () =>
      new Promise((resolve) => {
        finishConnect = resolve;
      }),
  });
  const row = {
    id: "github",
    icon: null,
    accountSummary: rows.accountLabelSummary,
    connectingDetail: ({ connectorId }) =>
      React.createElement("p", { "data-detail": connectorId }, "DEVICE CODE"),
  };
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () =>
    root.render(
      React.createElement(ConnectorLoginRow, {
        row,
        isPaid: true,
        blockedByOrg: false,
      })
    )
  );
  const connect = findElement(
    container,
    (element) => element.tagName === "BUTTON" && element.textContent === "connectors.github.connect"
  );
  assert.ok(connect, "the row's copy comes from connectors.github.*");
  assert.doesNotMatch(container.textContent, /DEVICE CODE/);

  await React.act(async () => click(connect));
  assert.match(container.textContent, /DEVICE CODE/);
  assert.ok(
    findElement(container, (element) => element.getAttribute?.("data-detail") === "github")
  );

  await React.act(async () => finishConnect({ status: "failed", errorCode: "oauth_cancelled" }));
  assert.doesNotMatch(container.textContent, /DEVICE CODE/);
});
