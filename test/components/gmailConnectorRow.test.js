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

const GMAIL = {
  id: "gmail",
  connected: true,
  configured: true,
  accountLabel: "you@example.test",
  workspaceLabel: null,
  needsReconnect: false,
};
const DISCONNECTED = { ...GMAIL, connected: false, accountLabel: null };

// The Gmail row with the real status store, loaded from `status`.
async function renderGmailRow(
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
    cachePrefix: "openwhispr-gmail-connector-row-test-",
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
  const [{ ConnectorLoginRow }, { CONNECTOR_ROWS }] = await Promise.all([
    vite.ssrLoadModule("/components/connectors/ConnectorLoginRow.tsx"),
    vite.ssrLoadModule("/components/connectors/connectorRows.tsx"),
  ]);
  const row = CONNECTOR_ROWS.find((entry) => entry.id === "gmail");
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () =>
    root.render(React.createElement(ConnectorLoginRow, { row, isPaid, blockedByOrg }))
  );
  // Let the status load from the mount effect commit.
  await React.act(async () => {});
  return container;
}

test("a build without a Google client shows no Gmail row", async (t) => {
  const container = await renderGmailRow(t, {
    status: { ...DISCONNECTED, configured: false },
  });
  assert.equal(container.textContent, "");
});

test("Connect opens Gmail's own login and says when send permission was left unticked", async (t) => {
  const connects = [];
  const container = await renderGmailRow(t, {
    status: DISCONNECTED,
    electronAPI: {
      connectorConnect: async (connectorId) => {
        connects.push(connectorId);
        return { status: "failed", errorCode: "permission_not_granted" };
      },
    },
  });
  assert.match(container.textContent, /connectors\.gmail\.description/);

  await React.act(async () => click(button(container, "connectors.gmail.connect")));

  assert.deepEqual(connects, ["gmail"]);
  assert.match(container.textContent, /connectors\.gmail\.errors\.permission_not_granted/);
  assert.doesNotMatch(container.textContent, /connectors\.gmail\.errors\.connect_failed/);
});

test("a Google Workspace admin block says so, not the generic access-wasn't-allowed message", async (t) => {
  const container = await renderGmailRow(t, {
    status: DISCONNECTED,
    electronAPI: {
      connectorConnect: async () => ({ status: "failed", errorCode: "domain_policy" }),
    },
  });

  await React.act(async () => click(button(container, "connectors.gmail.connect")));

  assert.match(container.textContent, /connectors\.gmail\.errors\.domain_policy/);
  assert.doesNotMatch(container.textContent, /connectors\.gmail\.errors\.oauth_denied/);
});

test("an unverified Google address gets its own message; an unknown failure the generic one", async (t) => {
  const answers = [
    { status: "failed", errorCode: "email_not_verified" },
    { status: "failed", errorCode: "invalid_scope" },
  ];
  const container = await renderGmailRow(t, {
    status: DISCONNECTED,
    electronAPI: { connectorConnect: async () => answers.shift() },
  });

  await React.act(async () => click(button(container, "connectors.gmail.connect")));
  assert.match(container.textContent, /connectors\.gmail\.errors\.email_not_verified/);

  await React.act(async () => click(button(container, "connectors.gmail.connect")));
  assert.match(container.textContent, /connectors\.gmail\.errors\.connect_failed/);
});

test("a connected Gmail names the account and disconnects Gmail, not Slack", async (t) => {
  const disconnects = [];
  const container = await renderGmailRow(t, {
    status: GMAIL,
    electronAPI: {
      connectorDisconnect: async (connectorId) => {
        disconnects.push(connectorId);
        return { status: "disconnected" };
      },
    },
  });
  assert.match(container.textContent, /connectors\.gmail\.connectedAs/);
  assert.equal(hasButton(container, "connectors.gmail.connect"), false);

  await React.act(async () => click(button(container, "connectors.gmail.disconnect")));

  assert.deepEqual(disconnects, ["gmail"]);
  assert.doesNotMatch(container.textContent, /connectors\.gmail\.errors\./);
});

test("a login that needs reconnecting offers Reconnect and Disconnect", async (t) => {
  const container = await renderGmailRow(t, { status: { ...GMAIL, needsReconnect: true } });
  assert.match(container.textContent, /connectors\.gmail\.needsReconnect/);
  assert.equal(hasButton(container, "connectors.gmail.reconnect"), true);
  assert.equal(hasButton(container, "connectors.gmail.disconnect"), true);
});

test("Reconnect shows the browser hint while it waits, like Connect", async (t) => {
  let finish;
  const container = await renderGmailRow(t, {
    status: { ...GMAIL, needsReconnect: true },
    electronAPI: {
      connectorConnect: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  });

  await React.act(async () => click(button(container, "connectors.gmail.reconnect")));
  // An admin block never redirects back, so the hint is the only guidance.
  assert.match(container.textContent, /connectors\.gmail\.connecting/);
  assert.doesNotMatch(container.textContent, /connectors\.gmail\.needsReconnect/);

  await React.act(async () => finish({ status: "failed", errorCode: "oauth_timeout" }));
  assert.match(container.textContent, /connectors\.gmail\.needsReconnect/);
  assert.match(container.textContent, /connectors\.gmail\.errors\.oauth_timeout/);
});

test("a disconnect that kept a grant the calendar shares says Google still lists the app", async (t) => {
  let reply = { status: "disconnected", grantKept: true };
  const container = await renderGmailRow(t, {
    status: GMAIL,
    electronAPI: { connectorDisconnect: async () => reply },
  });

  await React.act(async () => click(button(container, "connectors.gmail.disconnect")));
  assert.match(container.textContent, /connectors\.gmail\.grantKept/);

  reply = { status: "disconnected" };
  await React.act(async () => click(button(container, "connectors.gmail.disconnect")));
  assert.doesNotMatch(container.textContent, /connectors\.gmail\.grantKept/);
});

test("a free plan can still disconnect a Gmail login it has", async (t) => {
  const container = await renderGmailRow(t, { status: GMAIL, isPaid: false });
  assert.equal(hasButton(container, "connectors.gmail.disconnect"), true);
  assert.equal(hasButton(container, "connectors.gmail.connect"), false);
  assert.equal(hasButton(container, "integrations.api.viewPlans"), false);
});

test("a free plan without a login still sees what Gmail does, with no button", async (t) => {
  const container = await renderGmailRow(t, { status: DISCONNECTED, isPaid: false });
  assert.match(container.textContent, /connectors\.gmail\.description/);
  assert.match(container.textContent, /connectors\.beta/);
  assert.equal(hasButton(container, "integrations.api.viewPlans"), false);
  assert.equal(hasButton(container, "connectors.gmail.connect"), false);
});

test("with connectors turned off by the org, only Disconnect remains, even needing a reconnect", async (t) => {
  const container = await renderGmailRow(t, {
    status: { ...GMAIL, needsReconnect: true },
    blockedByOrg: true,
  });
  assert.equal(hasButton(container, "connectors.gmail.disconnect"), true);
  assert.equal(hasButton(container, "connectors.gmail.reconnect"), false);
  assert.equal(hasButton(container, "connectors.gmail.connect"), false);
});

test("with connectors turned off and no login, the row is hidden", async (t) => {
  const container = await renderGmailRow(t, { status: DISCONNECTED, blockedByOrg: true });
  assert.equal(container.textContent, "");
});

// Whether `node` sits inside something drawn at reduced opacity.
function isDimmed(node) {
  for (let current = node; current; current = current.parentNode) {
    if (current.getAttribute?.("class")?.split(/\s+/).includes("opacity-60")) return true;
  }
  return false;
}

function textNode(root, text) {
  const found = findElement(
    root,
    (element) => element.tagName === "P" && element.textContent === text
  );
  assert.ok(found, `${text} is rendered`);
  return found;
}

const lockIcon = (root) =>
  findElement(root, (element) => element.getAttribute?.("aria-label") === "connectors.locked");

test("a free plan without a login sees Gmail dimmed, with a lock that says why", async (t) => {
  const container = await renderGmailRow(t, { status: DISCONNECTED, isPaid: false });
  assert.equal(isDimmed(textNode(container, "connectors.gmail.title")), true);
  assert.equal(isDimmed(textNode(container, "connectors.gmail.description")), true);
  assert.ok(lockIcon(container), "the lock is labelled for screen readers");
});

test("a free plan with a login sees Gmail at full contrast and unlocked", async (t) => {
  const container = await renderGmailRow(t, { status: GMAIL, isPaid: false });
  assert.equal(isDimmed(textNode(container, "connectors.gmail.title")), false);
  assert.equal(isDimmed(button(container, "connectors.gmail.disconnect")), false);
  assert.equal(lockIcon(container), null);
});

test("on a free plan, what a disconnect leaves behind isn't dimmed with the locked row", async (t) => {
  let broadcast = null;
  const container = await renderGmailRow(t, {
    status: GMAIL,
    isPaid: false,
    electronAPI: {
      onConnectorStatusChanged: (listener) => {
        broadcast = listener;
        return () => {};
      },
      connectorDisconnect: async () => ({ status: "disconnected", grantKept: true }),
    },
  });

  await React.act(async () => click(button(container, "connectors.gmail.disconnect")));
  await React.act(async () => broadcast([DISCONNECTED]));

  assert.ok(lockIcon(container), "the row is locked once the login is gone");
  assert.equal(isDimmed(textNode(container, "connectors.gmail.title")), true);
  assert.equal(isDimmed(textNode(container, "connectors.gmail.grantKept")), false);
});
