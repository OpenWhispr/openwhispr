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

// Compared by identity: a failed assert.equal on DOM nodes would try to
// print the whole fake DOM.
function assertFocused(root, label) {
  assert.ok(root.ownerDocument.activeElement === button(root, label), `${label} has focus`);
}

const GITHUB = {
  id: "github",
  connected: true,
  configured: true,
  accountLabel: "@dana",
  workspaceLabel: "3",
  needsReconnect: false,
  manageUrl: "https://github.com/apps/openwhispr-dev/installations/new",
};
const DISCONNECTED = {
  ...GITHUB,
  connected: false,
  accountLabel: null,
  workspaceLabel: null,
  manageUrl: undefined,
};
const EXPIRES_AT = Date.UTC(2026, 8, 28, 15, 45);
const PROGRESS = {
  connectorId: "github",
  userCode: "WDJB-MJHT",
  verificationUri: "https://github.com/login/device",
  expiresAt: EXPIRES_AT,
};
// The same format the device code uses, in the mocked "en" UI language.
const EXPIRY = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(
  EXPIRES_AT
);

// A Connect that stays open until the test settles it, as the device flow does.
function pendingConnect() {
  const calls = [];
  let settle = () => {};
  return {
    calls,
    connectorConnect: (connectorId) => {
      calls.push(connectorId);
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
    settle: (result) => settle(result),
  };
}

// The GitHub entry of CONNECTOR_ROWS on the real row and status store.
async function renderGithubRow(
  t,
  { status, isPaid = true, blockedByOrg = false, electronAPI = {}, rowId = "github" } = {}
) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const progressListeners = new Set();
  const statusListeners = new Set();
  const opened = [];
  const copied = [];
  const cancels = [];
  // Real window focus/blur never fires in this harness, so the repositories
  // button's one-shot "came back to the window" listener is captured here and
  // fired manually with dispatchFocus.
  const focusListeners = new Map();
  installBrowserGlobals(t, {
    window: {
      addEventListener: (type, listener, options) => {
        if (type === "focus") focusListeners.set(listener, Boolean(options && options.once));
      },
      removeEventListener: (type, listener) => {
        if (type === "focus") focusListeners.delete(listener);
      },
      electronAPI: {
        connectorStatus: async () => (status ? [status] : []),
        onConnectorStatusChanged: (callback) => {
          statusListeners.add(callback);
          return () => statusListeners.delete(callback);
        },
        connectorRecentActions: async () => [],
        onConnectorConnectProgress: (callback) => {
          progressListeners.add(callback);
          return () => progressListeners.delete(callback);
        },
        writeClipboard: async (text) => {
          copied.push(text);
          return { success: true };
        },
        openExternal: async (url) => {
          opened.push(url);
          return { success: true };
        },
        connectorCancelConnect: async (connectorId) => {
          cancels.push(connectorId);
          return { status: "cancelled" };
        },
        ...electronAPI,
      },
    },
  });
  const container = installInteractiveDom(t);
  // The minimal DOM has no selectors; the row only asks for its first button.
  Object.getPrototypeOf(container).querySelector = function querySelector(selector) {
    assert.equal(selector, "button");
    return findElement(this, (element) => element !== this && element.tagName === "BUTTON");
  };
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-github-connector-row-test-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key, options) => (options ? key + JSON.stringify(options) : key);
        export const useTranslation = () => ({ t, i18n: { language: "en" } });
      `,
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
  const row = CONNECTOR_ROWS.find((entry) => entry.id === rowId);
  assert.ok(row, `CONNECTOR_ROWS has a ${rowId} entry`);
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  const render = (props = {}) =>
    React.act(async () =>
      root.render(
        React.createElement(ConnectorLoginRow, {
          row,
          isPaid,
          blockedByOrg,
          ...props,
        })
      )
    );
  await render();
  // Let the status load from the mount effect commit.
  await React.act(async () => {});
  const emitProgress = (progress) =>
    React.act(async () => {
      for (const listener of [...progressListeners]) listener(progress);
    });
  // What main broadcasts after a connect or disconnect changes the login.
  const broadcastStatus = (statuses) => {
    for (const listener of [...statusListeners]) listener(statuses);
  };
  // Leaving Settings: the whole row goes away.
  const unmount = async () => {
    await React.act(async () => root.unmount());
    root = null;
  };
  const dispatchFocus = () =>
    React.act(async () => {
      for (const [listener, once] of [...focusListeners]) {
        if (once) focusListeners.delete(listener);
        listener();
      }
    });
  return {
    container,
    emitProgress,
    progressListeners,
    broadcastStatus,
    render,
    unmount,
    opened,
    copied,
    cancels,
    dispatchFocus,
    focusListeners,
  };
}

test("GitHub is listed after Gmail and Slack", async (t) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-github-connector-rows-order-",
  });
  const { CONNECTOR_ROWS } = await vite.ssrLoadModule("/components/connectors/connectorRows.tsx");
  const ids = CONNECTOR_ROWS.map((row) => row.id);
  assert.deepEqual(ids.slice(0, 2), ["gmail", "slack"]);
  // Plan 4's Linear row sits before or after GitHub, whichever merged first.
  assert.deepEqual(
    ids.filter((id) => id === "github"),
    ["github"]
  );
});

test("a build without a GitHub App client shows no GitHub row", async (t) => {
  const { container } = await renderGithubRow(t, {
    status: { ...DISCONNECTED, configured: false },
  });
  assert.equal(container.textContent, "");
});

test("Connect shows GitHub's code once it arrives, and a newer code replaces it", async (t) => {
  const connect = pendingConnect();
  const { container, emitProgress } = await renderGithubRow(t, {
    status: DISCONNECTED,
    electronAPI: { connectorConnect: connect.connectorConnect },
  });

  await React.act(async () => click(button(container, "connectors.github.connect")));
  assert.deepEqual(connect.calls, ["github"]);
  assert.match(container.textContent, /connectors\.github\.connecting/);
  // No code until GitHub hands one out.
  assert.doesNotMatch(container.textContent, /deviceCode\.instructions/);

  await emitProgress(PROGRESS);
  assert.match(container.textContent, /connectors\.github\.deviceCode\.instructions/);
  assert.match(container.textContent, /WDJB-MJHT/);
  assert.ok(
    container.textContent.includes(
      `connectors.github.deviceCode.expires${JSON.stringify({ time: EXPIRY })}`
    ),
    "the expiry time is shown"
  );

  await emitProgress({ ...PROGRESS, userCode: "ABCD-EFGH", expiresAt: EXPIRES_AT + 60_000 });
  assert.match(container.textContent, /ABCD-EFGH/);
  assert.doesNotMatch(container.textContent, /WDJB-MJHT/);
});

test("another connector's progress never shows in the GitHub row", async (t) => {
  const connect = pendingConnect();
  const { container, emitProgress } = await renderGithubRow(t, {
    status: DISCONNECTED,
    electronAPI: { connectorConnect: connect.connectorConnect },
  });
  await React.act(async () => click(button(container, "connectors.github.connect")));

  await emitProgress({ ...PROGRESS, connectorId: "linear", userCode: "LINE-AR00" });
  assert.doesNotMatch(container.textContent, /LINE-AR00/);
  assert.doesNotMatch(container.textContent, /deviceCode\.instructions/);

  await emitProgress(PROGRESS);
  await emitProgress({ ...PROGRESS, connectorId: "linear", userCode: "LINE-AR00" });
  assert.match(container.textContent, /WDJB-MJHT/);
});

test("Copy & open GitHub copies the code and opens GitHub's device page", async (t) => {
  const connect = pendingConnect();
  const { container, emitProgress, copied, opened } = await renderGithubRow(t, {
    status: DISCONNECTED,
    electronAPI: { connectorConnect: connect.connectorConnect },
  });
  await React.act(async () => click(button(container, "connectors.github.connect")));
  await emitProgress(PROGRESS);

  await React.act(async () => click(button(container, "connectors.github.deviceCode.copyAndOpen")));

  assert.deepEqual(copied, ["WDJB-MJHT"]);
  assert.deepEqual(opened, ["https://github.com/login/device"]);
  assert.match(container.textContent, /connectors\.github\.deviceCode\.copied/);
});

test("a failed copy still opens GitHub, and never says the code was copied", async (t) => {
  const connect = pendingConnect();
  const { container, emitProgress, opened } = await renderGithubRow(t, {
    status: DISCONNECTED,
    electronAPI: {
      connectorConnect: connect.connectorConnect,
      writeClipboard: async () => {
        throw new Error("clipboard unavailable");
      },
    },
  });
  await React.act(async () => click(button(container, "connectors.github.connect")));
  await emitProgress(PROGRESS);

  await React.act(async () => click(button(container, "connectors.github.deviceCode.copyAndOpen")));

  assert.deepEqual(opened, ["https://github.com/login/device"]);
  assert.doesNotMatch(container.textContent, /deviceCode\.copied/);
});

test("a verification link off github.com is never opened", async (t) => {
  const connect = pendingConnect();
  const { container, emitProgress, opened } = await renderGithubRow(t, {
    status: DISCONNECTED,
    electronAPI: { connectorConnect: connect.connectorConnect },
  });
  await React.act(async () => click(button(container, "connectors.github.connect")));
  await emitProgress({ ...PROGRESS, verificationUri: "https://github.com.evil.test/login/device" });

  await React.act(async () => click(button(container, "connectors.github.deviceCode.copyAndOpen")));

  assert.deepEqual(opened, ["https://github.com/login/device"]);
});

test("when the connect ends, the code goes away and the row stops listening", async (t) => {
  const connect = pendingConnect();
  const { container, emitProgress, progressListeners } = await renderGithubRow(t, {
    status: DISCONNECTED,
    electronAPI: { connectorConnect: connect.connectorConnect },
  });
  await React.act(async () => click(button(container, "connectors.github.connect")));
  await emitProgress(PROGRESS);
  assert.equal(progressListeners.size, 1);

  await React.act(async () => connect.settle({ status: "failed", errorCode: "oauth_cancelled" }));

  assert.doesNotMatch(container.textContent, /WDJB-MJHT/);
  assert.equal(progressListeners.size, 0, "the progress listener was removed on unmount");
  // A cancelled connect is not an error.
  assert.doesNotMatch(container.textContent, /connectors\.github\.errors\./);
});

test("Cancel stops GitHub's connect, and the row reads as before Connect", async (t) => {
  const connect = pendingConnect();
  const { container, emitProgress, cancels } = await renderGithubRow(t, {
    status: DISCONNECTED,
    electronAPI: { connectorConnect: connect.connectorConnect },
  });
  await React.act(async () => click(button(container, "connectors.github.connect")));
  await emitProgress(PROGRESS);

  await React.act(async () => click(button(container, "connectors.github.deviceCode.cancel")));
  assert.deepEqual(cancels, ["github"]);
  // Main ends the connect as cancelled, which is not an error.
  await React.act(async () => connect.settle({ status: "failed", errorCode: "oauth_cancelled" }));

  assert.doesNotMatch(container.textContent, /WDJB-MJHT/);
  assert.doesNotMatch(container.textContent, /connectors\.github\.errors\./);
  assert.equal(hasButton(container, "connectors.github.connect"), true);
});

test("while GitHub's connect waits, Cancel is there before the code and Connect isn't offered again", async (t) => {
  const connect = pendingConnect();
  const { container, emitProgress, cancels } = await renderGithubRow(t, {
    status: DISCONNECTED,
    electronAPI: { connectorConnect: connect.connectorConnect },
  });
  await React.act(async () => click(button(container, "connectors.github.connect")));

  // Asking GitHub for a code can take a while: the user can already stop it.
  assert.equal(hasButton(container, "connectors.github.deviceCode.cancel"), true);
  // A second Connect would silently replace a code the user may have typed.
  assert.equal(hasButton(container, "connectors.github.connect"), false);
  await emitProgress(PROGRESS);
  assert.equal(hasButton(container, "connectors.github.connect"), false);

  await React.act(async () => click(button(container, "connectors.github.deviceCode.cancel")));
  assert.deepEqual(cancels, ["github"]);
  await React.act(async () => connect.settle({ status: "failed", errorCode: "oauth_cancelled" }));
  assert.equal(hasButton(container, "connectors.github.connect"), true);
  assert.deepEqual(connect.calls, ["github"]);
});

test("the code lands in a live region that was there first, and Cancel hands focus back to Connect", async (t) => {
  const connect = pendingConnect();
  const { container, emitProgress } = await renderGithubRow(t, {
    status: DISCONNECTED,
    electronAPI: { connectorConnect: connect.connectorConnect },
  });
  await React.act(async () => click(button(container, "connectors.github.connect")));
  const live = findElement(
    container,
    (element) => element.getAttribute?.("aria-live") === "polite"
  );
  assert.ok(live, "a polite live region is mounted before the code arrives");
  assert.equal(live.textContent, "");

  await emitProgress(PROGRESS);
  assert.match(live.textContent, /WDJB-MJHT/);

  const cancel = button(container, "connectors.github.deviceCode.cancel");
  cancel.focus();
  await React.act(async () => click(cancel));
  await React.act(async () => connect.settle({ status: "failed", errorCode: "oauth_cancelled" }));

  // Cancel is gone; focus moves to Connect instead of dropping to the page.
  assertFocused(container, "connectors.github.connect");
});

test("Cancel before the code arrives stops the connect and hands focus back to Connect", async (t) => {
  const connect = pendingConnect();
  const { container, cancels } = await renderGithubRow(t, {
    status: DISCONNECTED,
    electronAPI: { connectorConnect: connect.connectorConnect },
  });
  await React.act(async () => click(button(container, "connectors.github.connect")));
  const cancel = button(container, "connectors.github.deviceCode.cancel");
  cancel.focus();

  await React.act(async () => click(cancel));
  assert.deepEqual(cancels, ["github"]);
  await React.act(async () => connect.settle({ status: "failed", errorCode: "oauth_cancelled" }));

  assert.doesNotMatch(container.textContent, /connectors\.github\.errors\./);
  assertFocused(container, "connectors.github.connect");
});

// Connect and Reconnect go away while the row connects, so a keyboard user's
// focus follows to Cancel instead of dropping to the page.
for (const [label, status] of [
  ["connectors.github.connect", DISCONNECTED],
  ["connectors.github.reconnect", { ...GITHUB, needsReconnect: true }],
]) {
  test(`pressing a focused ${label.split(".").pop()} hands focus to Cancel`, async (t) => {
    const connect = pendingConnect();
    const { container } = await renderGithubRow(t, {
      status,
      electronAPI: { connectorConnect: connect.connectorConnect },
    });
    const pressed = button(container, label);
    pressed.focus();

    await React.act(async () => click(pressed));

    assert.equal(hasButton(container, label), false);
    assertFocused(container, "connectors.github.deviceCode.cancel");
  });
}

test("Connect pressed while focus is elsewhere leaves focus where it is", async (t) => {
  const connect = pendingConnect();
  const { container } = await renderGithubRow(t, {
    status: DISCONNECTED,
    electronAPI: { connectorConnect: connect.connectorConnect },
  });
  const elsewhere = container.ownerDocument.createElement("input");
  elsewhere.focus();

  await React.act(async () => click(button(container, "connectors.github.connect")));

  assert.equal(hasButton(container, "connectors.github.deviceCode.cancel"), true);
  assert.ok(container.ownerDocument.activeElement === elsewhere, "focus stayed put");
});

// Main broadcasts the new login before the connect resolves, so the row is
// connected by the time Copy & open (which held focus) unmounts.
async function connectWhileFocused(t, connectedStatus) {
  const connect = pendingConnect();
  let current = DISCONNECTED;
  const row = await renderGithubRow(t, {
    status: DISCONNECTED,
    electronAPI: {
      connectorConnect: connect.connectorConnect,
      connectorStatus: async () => [current],
    },
  });
  await React.act(async () => click(button(row.container, "connectors.github.connect")));
  await row.emitProgress(PROGRESS);
  button(row.container, "connectors.github.deviceCode.copyAndOpen").focus();

  current = connectedStatus;
  await React.act(async () => {
    row.broadcastStatus([connectedStatus]);
    connect.settle({ status: "connected" });
  });
  return row;
}

test("a successful connect hands focus to the row's next step, not the page", async (t) => {
  const { container } = await connectWhileFocused(t, GITHUB);
  assertFocused(container, "connectors.github.repositories.manage");
});

test("with no repositories button, a successful connect hands focus to Disconnect", async (t) => {
  const { container } = await connectWhileFocused(t, { ...GITHUB, manageUrl: undefined });
  assertFocused(container, "connectors.github.disconnect");
});

test("a connect that lands before the count hands focus to Disconnect, and keeps it there", async (t) => {
  const pending = { ...GITHUB, workspaceLabel: null, workspaceLabelPending: true };
  const { container, broadcastStatus } = await connectWhileFocused(t, pending);
  assertFocused(container, "connectors.github.disconnect");

  // Main announces the count once it has read it.
  await React.act(async () => broadcastStatus([{ ...GITHUB, workspaceLabel: "0" }]));

  assert.equal(hasButton(container, "connectors.github.repositories.choose"), true);
  assertFocused(container, "connectors.github.disconnect");
});

test("the org turning connectors off mid-connect stops it, once", async (t) => {
  const connect = pendingConnect();
  const { container, emitProgress, render, unmount, cancels } = await renderGithubRow(t, {
    status: DISCONNECTED,
    electronAPI: { connectorConnect: connect.connectorConnect },
  });
  await React.act(async () => click(button(container, "connectors.github.connect")));
  await emitProgress(PROGRESS);

  await render({ blockedByOrg: true });
  assert.deepEqual(cancels, ["github"]);
  assert.equal(container.textContent, "");

  await unmount();
  connect.settle({ status: "failed", errorCode: "oauth_cancelled" });
  await React.act(async () => {});
  assert.deepEqual(cancels, ["github"]);
});

test("a connect that ends while focus is elsewhere leaves focus where it is", async (t) => {
  const connect = pendingConnect();
  const { container } = await renderGithubRow(t, {
    status: DISCONNECTED,
    electronAPI: { connectorConnect: connect.connectorConnect },
  });
  await React.act(async () => click(button(container, "connectors.github.connect")));
  const elsewhere = container.ownerDocument.createElement("input");
  elsewhere.isConnected = true;
  elsewhere.focus();

  await React.act(async () => connect.settle({ status: "failed", errorCode: "code_expired" }));

  assert.ok(container.ownerDocument.activeElement === elsewhere, "focus stayed put");
});

test("leaving Settings while the code is showing stops the connect, once", async (t) => {
  const connect = pendingConnect();
  const { container, emitProgress, unmount, cancels } = await renderGithubRow(t, {
    status: DISCONNECTED,
    electronAPI: { connectorConnect: connect.connectorConnect },
  });
  await React.act(async () => click(button(container, "connectors.github.connect")));
  await emitProgress(PROGRESS);

  await unmount();
  connect.settle({ status: "failed", errorCode: "oauth_cancelled" });
  await React.act(async () => {});

  assert.deepEqual(cancels, ["github"]);
});

test("leaving Settings after the connect finished stops nothing", async (t) => {
  const connect = pendingConnect();
  const { container, emitProgress, unmount, cancels } = await renderGithubRow(t, {
    status: DISCONNECTED,
    electronAPI: { connectorConnect: connect.connectorConnect },
  });
  await React.act(async () => click(button(container, "connectors.github.connect")));
  await emitProgress(PROGRESS);
  await React.act(async () =>
    connect.settle({ status: "connected", accountLabel: "@dana", workspaceLabel: "3" })
  );

  await unmount();

  assert.deepEqual(cancels, []);
});

test("leaving Settings mid-connect leaves other connectors' sign-ins alone", async (t) => {
  const connect = pendingConnect();
  const { container, unmount, cancels } = await renderGithubRow(t, {
    rowId: "gmail",
    status: {
      id: "gmail",
      connected: false,
      configured: true,
      accountLabel: null,
      workspaceLabel: null,
      needsReconnect: false,
    },
    electronAPI: { connectorConnect: connect.connectorConnect },
  });
  await React.act(async () => click(button(container, "connectors.gmail.connect")));

  await unmount();

  assert.deepEqual(connect.calls, ["gmail"]);
  assert.deepEqual(cancels, [], "the browser sign-in keeps going");
});

test("an expired code, a disabled device flow and an unreachable GitHub each get their own message", async (t) => {
  const answers = [
    { status: "failed", errorCode: "code_expired" },
    { status: "failed", errorCode: "device_flow_disabled" },
    { status: "failed", errorCode: "oauth_denied" },
    // No code could be asked for: offline, or GitHub throttled the request.
    { status: "failed", errorCode: "network" },
    { status: "failed", errorCode: "rate_limited" },
  ];
  const { container } = await renderGithubRow(t, {
    status: DISCONNECTED,
    electronAPI: { connectorConnect: async () => answers.shift() },
  });

  await React.act(async () => click(button(container, "connectors.github.connect")));
  assert.match(container.textContent, /connectors\.github\.errors\.code_expired/);

  await React.act(async () => click(button(container, "connectors.github.connect")));
  assert.match(container.textContent, /connectors\.github\.errors\.device_flow_disabled/);

  await React.act(async () => click(button(container, "connectors.github.connect")));
  assert.match(container.textContent, /connectors\.github\.errors\.oauth_denied/);
  assert.doesNotMatch(container.textContent, /errors\.connect_failed/);

  await React.act(async () => click(button(container, "connectors.github.connect")));
  assert.match(container.textContent, /connectors\.github\.errors\.network/);

  await React.act(async () => click(button(container, "connectors.github.connect")));
  assert.match(container.textContent, /connectors\.github\.errors\.rate_limited/);
  assert.doesNotMatch(container.textContent, /errors\.connect_failed/);
});

test("a connected login names the account and its repository count, with Manage repositories", async (t) => {
  const { container, opened } = await renderGithubRow(t, { status: GITHUB });

  assert.ok(
    container.textContent.includes(
      `connectors.github.connectedAs${JSON.stringify({ account: "@dana", repositories: "3" })}`
    ),
    "the summary names the login and the repository count"
  );
  assert.equal(hasButton(container, "connectors.github.repositories.choose"), false);
  await React.act(async () => click(button(container, "connectors.github.repositories.manage")));
  assert.deepEqual(opened, [GITHUB.manageUrl]);
  assert.equal(hasButton(container, "connectors.github.disconnect"), true);
});

test("with no repositories chosen yet, the row offers Choose repositories", async (t) => {
  const { container, opened } = await renderGithubRow(t, {
    status: { ...GITHUB, workspaceLabel: "0" },
  });
  // connectedAs_empty: "Connected as @dana · no repositories yet".
  assert.ok(
    container.textContent.includes(
      `connectors.github.connectedAs${JSON.stringify({ account: "@dana", context: "empty" })}`
    )
  );
  assert.equal(hasButton(container, "connectors.github.repositories.manage"), false);

  await React.act(async () => click(button(container, "connectors.github.repositories.choose")));

  assert.deepEqual(opened, [GITHUB.manageUrl]);
});

test("a repository count that couldn't be read shows just the login, never 'none yet'", async (t) => {
  const { container } = await renderGithubRow(t, { status: { ...GITHUB, workspaceLabel: null } });
  // connectedAs_unknown: "Connected as @dana".
  assert.ok(
    container.textContent.includes(
      `connectors.github.connectedAs${JSON.stringify({ account: "@dana", context: "unknown" })}`
    )
  );
  assert.doesNotMatch(container.textContent, /"repositories"|"empty"/);
  assert.equal(hasButton(container, "connectors.github.repositories.choose"), false);
  assert.equal(hasButton(container, "connectors.github.repositories.manage"), true);
});

test("until the first count is read, the row shows just the login and no repositories button", async (t) => {
  const { container } = await renderGithubRow(t, {
    status: { ...GITHUB, workspaceLabel: "3", workspaceLabelPending: true },
  });
  assert.ok(
    container.textContent.includes(
      `connectors.github.connectedAs${JSON.stringify({ account: "@dana", context: "unknown" })}`
    ),
    "no count suffix while it is being read"
  );
  assert.equal(hasButton(container, "connectors.github.repositories.manage"), false);
  assert.equal(hasButton(container, "connectors.github.repositories.choose"), false);
  assert.equal(hasButton(container, "connectors.github.disconnect"), true);
});

test("with none chosen, every return to the window re-reads the count, however the install was made", async (t) => {
  let fetches = 0;
  const { container, dispatchFocus, opened } = await renderGithubRow(t, {
    status: { ...GITHUB, workspaceLabel: "0" },
    electronAPI: {
      // The row's own load and this button's mount refresh read "0"; so does
      // the first return to the window. The install lands before the second.
      connectorStatus: async () => {
        fetches += 1;
        return [{ ...GITHUB, workspaceLabel: fetches <= 3 ? "0" : "2" }];
      },
    },
  });
  assert.equal(fetches, 2, "the row and the button each read the status once on mount");

  // Installed on GitHub's own site: no click in the row at all.
  await dispatchFocus();
  assert.equal(fetches, 3);
  assert.equal(hasButton(container, "connectors.github.repositories.choose"), true);

  await React.act(async () => click(button(container, "connectors.github.repositories.choose")));
  assert.deepEqual(opened, [GITHUB.manageUrl]);
  // No refetch from the click itself: only coming back to the window does.
  assert.equal(fetches, 3);

  await dispatchFocus();

  assert.equal(fetches, 4);
  assert.equal(hasButton(container, "connectors.github.repositories.manage"), true);
  assert.equal(hasButton(container, "connectors.github.repositories.choose"), false);
});

test("focus re-reads stop once repositories are chosen; Manage arms one re-read, removed on unmount", async (t) => {
  let fetches = 0;
  const { container, dispatchFocus, focusListeners, unmount } = await renderGithubRow(t, {
    status: { ...GITHUB, workspaceLabel: "0" },
    electronAPI: {
      connectorStatus: async () => {
        fetches += 1;
        return [{ ...GITHUB, workspaceLabel: fetches <= 2 ? "0" : "2" }];
      },
    },
  });
  // One lasting listener while none are chosen.
  assert.deepEqual([...focusListeners.values()], [false]);

  await dispatchFocus();
  assert.equal(hasButton(container, "connectors.github.repositories.manage"), true);
  assert.equal(focusListeners.size, 0, "no focus listener once a repository is chosen");
  await dispatchFocus();
  assert.equal(fetches, 3, "later returns to the window ask GitHub nothing");

  await React.act(async () => click(button(container, "connectors.github.repositories.manage")));
  assert.deepEqual([...focusListeners.values()], [true]);
  await dispatchFocus();
  assert.equal(fetches, 4);
  assert.equal(focusListeners.size, 0, "a one-shot listener removes itself once fired");

  await React.act(async () => click(button(container, "connectors.github.repositories.manage")));
  await unmount();
  assert.equal(focusListeners.size, 0, "unmounting removes a still-pending listener");
});

test("the three summaries read as intended in English", async () => {
  // tsx loads the ESM default export through CommonJS interop.
  const mod = await import("../../src/i18n.ts");
  const i18n = mod.default.default ?? mod.default;
  const t = i18n.getFixedT("en");
  const login = { account: "@dana" };
  assert.equal(
    t("connectors.github.connectedAs", { ...login, repositories: "3" }),
    "Connected as @dana · Repositories: 3"
  );
  assert.equal(
    t("connectors.github.connectedAs", { ...login, context: "empty" }),
    "Connected as @dana · no repositories yet"
  );
  assert.equal(
    t("connectors.github.connectedAs", { ...login, context: "unknown" }),
    "Connected as @dana"
  );
});

test("a build without an App slug shows no repositories button", async (t) => {
  const { container } = await renderGithubRow(t, { status: { ...GITHUB, manageUrl: undefined } });
  assert.equal(hasButton(container, "connectors.github.repositories.manage"), false);
  assert.equal(hasButton(container, "connectors.github.repositories.choose"), false);
  assert.equal(hasButton(container, "connectors.github.disconnect"), true);
});

test("with connectors turned off by the org, only Disconnect remains", async (t) => {
  const { container } = await renderGithubRow(t, { status: GITHUB, blockedByOrg: true });
  assert.equal(hasButton(container, "connectors.github.disconnect"), true);
  assert.equal(hasButton(container, "connectors.github.repositories.manage"), false);
});

test("a free plan keeps Disconnect for its login but can't manage repositories", async (t) => {
  const { container } = await renderGithubRow(t, { status: GITHUB, isPaid: false });
  assert.equal(hasButton(container, "connectors.github.disconnect"), true);
  assert.equal(hasButton(container, "connectors.github.repositories.manage"), false);
});

test("a login that needs reconnecting offers Reconnect and Disconnect", async (t) => {
  const { container } = await renderGithubRow(t, { status: { ...GITHUB, needsReconnect: true } });
  assert.match(container.textContent, /connectors\.github\.needsReconnect/);
  assert.equal(hasButton(container, "connectors.github.reconnect"), true);
  assert.equal(hasButton(container, "connectors.github.disconnect"), true);
  // Its repository count can't refresh until it reconnects.
  assert.doesNotMatch(container.textContent, /connectors\.github\.repositories\./);
});

test("after Disconnect, the row links to GitHub's authorizations page", async (t) => {
  const disconnects = [];
  let broadcast = () => {};
  const { container, opened, broadcastStatus } = await renderGithubRow(t, {
    status: GITHUB,
    electronAPI: {
      connectorDisconnect: async (connectorId) => {
        disconnects.push(connectorId);
        broadcast([DISCONNECTED]);
        return { status: "disconnected" };
      },
    },
  });
  broadcast = broadcastStatus;
  assert.equal(hasButton(container, "connectors.github.reviewOnGithub"), false);

  await React.act(async () => click(button(container, "connectors.github.disconnect")));

  assert.deepEqual(disconnects, ["github"]);
  assert.match(container.textContent, /connectors\.github\.disconnectedHint/);
  await React.act(async () => click(button(container, "connectors.github.reviewOnGithub")));
  assert.deepEqual(opened, ["https://github.com/settings/apps/authorizations"]);
});

test("switching OpenWhispr accounts clears the previous account's Disconnect note", async (t) => {
  const scopeListeners = new Set();
  let broadcast = () => {};
  const { container, broadcastStatus } = await renderGithubRow(t, {
    status: GITHUB,
    electronAPI: {
      connectorDisconnect: async () => {
        broadcast([DISCONNECTED]);
        return { status: "disconnected" };
      },
      onActiveAccountScopeChanged: (callback) => {
        scopeListeners.add(callback);
        return () => scopeListeners.delete(callback);
      },
    },
  });
  broadcast = broadcastStatus;
  await React.act(async () => click(button(container, "connectors.github.disconnect")));
  assert.match(container.textContent, /connectors\.github\.disconnectedHint/);

  await React.act(async () => {
    for (const listener of [...scopeListeners]) listener({ accountId: "someone-else" });
  });

  assert.doesNotMatch(container.textContent, /connectors\.github\.disconnectedHint/);
  assert.equal(hasButton(container, "connectors.github.reviewOnGithub"), false);
});

test("a failed Disconnect doesn't point at GitHub's authorizations page", async (t) => {
  const { container } = await renderGithubRow(t, {
    status: GITHUB,
    electronAPI: {
      connectorDisconnect: async () => ({ status: "failed", errorCode: "disconnect_failed" }),
    },
  });

  await React.act(async () => click(button(container, "connectors.github.disconnect")));

  assert.match(container.textContent, /connectors\.github\.errors\.disconnect_failed/);
  assert.equal(hasButton(container, "connectors.github.reviewOnGithub"), false);
});

test("rows without the GitHub hooks are unchanged: Gmail shows no repositories button", async (t) => {
  const { container } = await renderGithubRow(t, {
    rowId: "gmail",
    status: {
      id: "gmail",
      connected: true,
      configured: true,
      accountLabel: "you@example.test",
      workspaceLabel: null,
      needsReconnect: false,
    },
  });
  assert.match(container.textContent, /connectors\.gmail\.connectedAs/);
  assert.doesNotMatch(container.textContent, /repositories/);
  assert.equal(hasButton(container, "connectors.gmail.disconnect"), true);
});
