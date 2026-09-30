const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");

const { createElement } = React;
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { findElement, installInteractiveDom } = require("../lib/interactiveDom");

const MOCKS = {
  "/stores/policyStore": `
    export function usePolicyStore(selector) { return selector({}); }
  `,
  "/stores/policyRules": `
    export function isConnectorsBlockedByOrg() { return globalThis.__connectorsBlocked; }
    export function isConnectorsAllowed() { return globalThis.__connectorsAllowed; }
  `,
  "/stores/settingsStore": `
    const state = {
      isSignedIn: true,
      emailDraftTarget: globalThis.__emailDraftTarget ?? "auto",
      setEmailDraftTarget() {},
      gcalConnected: false,
      mcalAccounts: [{ email: "a@corp.com", tenantId: null }],
    };
    export function useSettingsStore(selector) { return selector(state); }
  `,
  "/lib/usageStore": `
    export const getUsageState = () => globalThis.__usage;
    export const subscribeUsage = () => () => {};
  `,
  "/lib/subscriptionFlag": `
    export const readIsSubscribed = () => Boolean(globalThis.__subscribedFlag);
    export const subscribeIsSubscribed = () => () => {};
  `,
  "react-i18next": `
    const t = (key, options) => (options ? key + JSON.stringify(options) : key);
    export const useTranslation = () => ({ t, i18n: { language: "en" } });
  `,
  "/ui/select": `
    import React from "react";
    const Pass = ({ children }) => React.createElement("div", null, children);
    export const Select = ({ children, value }) =>
      React.createElement("div", { "data-select-value": value }, children);
    export const SelectContent = Pass;
    export const SelectTrigger = Pass;
    export const SelectValue = () => null;
    export const SelectItem = ({ children, value, disabled }) =>
      React.createElement(
        "span",
        { "data-value": value, "data-disabled": disabled ? "true" : "false" },
        children
      );
  `,
  "/ui/button": `
    import React from "react";
    export function Button(props) { return React.createElement("button", props); }
  `,
  "/stores/connectorStatusStore": `
    export function useConnectorStatusStore(selector) {
      return selector({ statuses: globalThis.__connectorStatuses ?? {} });
    }
    export async function ensureConnectorStatus() {}
  `,
};

const usage = (isSubscribed) => ({
  status: "success",
  accountId: "acct",
  data: { isSubscribed, isTrial: false },
  isRefreshing: false,
});

const SLACK = {
  id: "slack",
  connected: true,
  accountLabel: "chad",
  workspaceLabel: "Acme Test",
  needsReconnect: false,
};
const count = (markup, pattern) => (markup.match(pattern) ?? []).length;
// This harness's DOM nodes only expose textContent (no innerHTML), so a plain
// string like "connectors.slack.connect" can't be told apart from a longer
// key that starts with it ("connectors.slack.connecting",
// "…connectedAs"). Finding the actual <button> is unambiguous.
const buttonWithText = (container, text) =>
  findElement(container, (node) => node.tagName === "BUTTON" && node.textContent === text);

// `usageState`/`subscribedFlag` are the review round's shape; `isPaid` is a
// shortcut for tests that don't care about the usage/flag distinction. An org
// block is a resolved policy that disallows connectors, so it implies not
// allowed; `allowed: false` alone is a policy that is loading or failed.
function setPlan(
  t,
  {
    usageState,
    subscribedFlag = false,
    blocked = false,
    allowed = !blocked,
    isPaid,
    statuses = {},
    emailDraftTarget,
  } = {}
) {
  globalThis.__emailDraftTarget = emailDraftTarget;
  globalThis.__usage = usageState ?? usage(Boolean(isPaid));
  globalThis.__subscribedFlag = isPaid ?? subscribedFlag;
  globalThis.__connectorsBlocked = blocked;
  globalThis.__connectorsAllowed = allowed;
  globalThis.__connectorStatuses = statuses;
  t.after(() => {
    delete globalThis.__emailDraftTarget;
    delete globalThis.__usage;
    delete globalThis.__subscribedFlag;
    delete globalThis.__connectorsBlocked;
    delete globalThis.__connectorsAllowed;
    delete globalThis.__connectorStatuses;
  });
}

async function renderSection(t, plan, electronAPI = {}) {
  // Registered first so it runs before the globals it needs are torn down.
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { window: { electronAPI } });
  setPlan(t, plan);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-connectors-section-test-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  const { ConnectorsSection } = await vite.ssrLoadModule("/components/ConnectorsSection.tsx");
  root = createRoot(container);
  await React.act(async () => root.render(createElement(ConnectorsSection, { onUpgrade() {} })));
  return container;
}

function listItems(container) {
  const items = [];
  const walk = (node) => {
    if (node.tagName === "LI") items.push(node.textContent);
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(container);
  return items;
}

const receipt = (id, destinationLabel, state = "sent") => ({
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

test("paid users choose where drafts open", async (t) => {
  const { textContent } = await renderSection(t, { usageState: usage(true) });
  assert.match(textContent, /connectors\.email\.title/);
  assert.match(textContent, /connectors\.email\.targets\.gmail/);
  assert.match(textContent, /connectors\.email\.description/);
  assert.doesNotMatch(textContent, /integrations\.api\.viewPlans/);
});

test("automatic names the app it resolved to", async (t) => {
  const { textContent } = await renderSection(t, { usageState: usage(true) });
  assert.match(
    textContent,
    /connectors\.email\.autoResolved\{"target":"connectors\.email\.targets\.outlookWork"\}/
  );
});

test("while usage is unknown, the card follows the saved flag like the chat does", async (t) => {
  const loading = { status: "loading", accountId: "acct" };
  const { textContent } = await renderSection(t, { usageState: loading, subscribedFlag: true });
  assert.match(textContent, /connectors\.email\.description/);
});

test("while usage is unknown and the flag is unset, the card asks for a plan", async (t) => {
  const loading = { status: "loading", accountId: "acct" };
  const { textContent } = await renderSection(t, { usageState: loading, subscribedFlag: false });
  assert.match(textContent, /connectors\.email\.proRequired/);
});

test("free users see that a paid plan is required and a View Plans button", async (t) => {
  const container = await renderSection(t, { usageState: usage(false) });
  // Matches the API card pattern (IntegrationsView.tsx): the description says
  // a paid plan is required, and the CTA is the primary/filled button.
  assert.match(container.textContent, /connectors\.email\.proRequired/);
  assert.doesNotMatch(container.textContent, /connectors\.email\.description/);
  assert.doesNotMatch(container.textContent, /connectors\.email\.targets\.gmail/);
  const button = findElement(container, (node) => node.tagName === "BUTTON");
  assert.match(button.textContent, /integrations\.api\.viewPlans/);
  assert.equal(button.getAttribute("variant"), null);
});

test("an org that turned connectors off sees why, under the card's header", async (t) => {
  const { textContent } = await renderSection(t, { usageState: usage(true), blocked: true });
  assert.match(textContent, /connectors\.email\.title/);
  assert.match(textContent, /connectors\.policyOff/);
  assert.doesNotMatch(textContent, /connectors\.email\.targets/);
  assert.doesNotMatch(textContent, /integrations\.api\.viewPlans/);
});

test("while the policy is unresolved, the card says drafts are unavailable", async (t) => {
  let fetches = 0;
  const container = await renderSection(
    t,
    { usageState: usage(true), allowed: false },
    {
      connectorRecentActions: async () => {
        fetches += 1;
        return [receipt("a", "gabe@example.com")];
      },
    }
  );
  assert.match(container.textContent, /connectors\.email\.unavailable/);
  assert.doesNotMatch(container.textContent, /connectors\.email\.description/);
  assert.doesNotMatch(container.textContent, /connectors\.email\.targets/);
  assert.doesNotMatch(container.textContent, /connectors\.policyOff/);
  assert.doesNotMatch(container.textContent, /integrations\.api\.viewPlans/);
  assert.equal(fetches, 0);
});

test("an unresolved policy doesn't hide the upsell from a free user", async (t) => {
  const { textContent } = await renderSection(t, { usageState: usage(false), allowed: false });
  assert.match(textContent, /connectors\.email\.proRequired/);
  assert.match(textContent, /integrations\.api\.viewPlans/);
});

test("a change of main's account scope clears and refetches the receipts", async (t) => {
  // The login rows listen too, as main's preload allows.
  const scopeListeners = new Set();
  let answerSecondFetch = null;
  const answers = [
    Promise.resolve([receipt("a", "first@example.com")]),
    new Promise((resolve) => {
      answerSecondFetch = resolve;
    }),
  ];
  let fetches = 0;
  const container = await renderSection(
    t,
    { usageState: usage(true) },
    {
      onActiveAccountScopeChanged: (callback) => {
        scopeListeners.add(callback);
        return () => scopeListeners.delete(callback);
      },
      connectorRecentActions: () => answers[fetches++],
    }
  );
  assert.match(listItems(container).join(), /first@example\.com/);

  assert.ok(scopeListeners.size > 0);
  await React.act(async () => {
    for (const listener of [...scopeListeners])
      listener({ accountId: "acct-b", authGeneration: 2 });
  });
  assert.equal(fetches, 2);
  assert.deepEqual(listItems(container), []);

  await React.act(async () => answerSecondFetch([receipt("b", "second@example.com")]));
  const items = listItems(container);
  assert.equal(items.length, 1);
  assert.match(items[0], /second@example\.com/);
});

test("recent receipts name the recipient, or the action when a quit cut it short", async (t) => {
  const container = await renderSection(
    t,
    { usageState: usage(true) },
    {
      connectorRecentActions: async () => [
        receipt("a", "gabe@example.com", "failed"),
        receipt("b", null, "unknown"),
      ],
    }
  );

  const items = listItems(container);
  assert.equal(items.length, 2);
  assert.match(items[0], /^connectors\.recent\.actions\.email_draft/);
  assert.match(items[1], /^connectors\.recent\.unlabeledActions\.email_draft/);
});

test("a connected Slack shows the account and Disconnect", async (t) => {
  const container = await renderSection(t, {
    isPaid: true,
    blocked: false,
    statuses: { slack: SLACK },
  });
  const markup = container.textContent;
  assert.match(markup, /connectors\.slack\.title/);
  assert.match(markup, /connectors\.slack\.connectedAs/);
  assert.match(markup, /connectors\.slack\.disconnect/);
  assert.equal(buttonWithText(container, "connectors.slack.connect"), null);
});

// Each of the pairs below is one scenario from the brief, split into two
// tests: this harness's globals (window/document) are installed and torn
// down per-test in registration order, so a second renderSection() call in
// the same test tears down the first call's globals out from under its
// still-pending root.unmount() cleanup.
test("a disconnected Slack offers Connect", async (t) => {
  const disconnected = await renderSection(t, { isPaid: true, blocked: false });
  assert.ok(buttonWithText(disconnected, "connectors.slack.connect"));
  assert.match(disconnected.textContent, /connectors\.slack\.description/);
});

test("a stale login offers Reconnect and Disconnect", async (t) => {
  const stale = await renderSection(t, {
    isPaid: true,
    blocked: false,
    statuses: { slack: { ...SLACK, needsReconnect: true } },
  });
  const staleMarkup = stale.textContent;
  assert.match(staleMarkup, /connectors\.slack\.reconnect/);
  assert.match(staleMarkup, /connectors\.slack\.disconnect/);
  assert.match(staleMarkup, /connectors\.slack\.needsReconnect/);
});

test("free users with no login see Upgrade on every row and no Connect", async (t) => {
  const none = await renderSection(t, { isPaid: false, blocked: false });
  // Email, Gmail, Slack, Linear and GitHub.
  assert.equal(count(none.textContent, /integrations\.api\.viewPlans/g), 5);
  assert.equal(buttonWithText(none, "connectors.slack.connect"), null);
});

test("free users can always disconnect a login they have", async (t) => {
  const lapsed = await renderSection(t, {
    isPaid: false,
    blocked: false,
    statuses: { slack: SLACK },
  });
  assert.match(lapsed.textContent, /connectors\.slack\.disconnect/);
  assert.equal(
    count(lapsed.textContent, /integrations\.api\.viewPlans/g),
    4,
    "only the email, Gmail, Linear and GitHub rows' Upgrade"
  );
});

test("an org that turned connectors off still lets the user remove a login", async (t) => {
  const connected = await renderSection(t, {
    isPaid: true,
    blocked: true,
    statuses: { slack: SLACK },
  });
  const connectedMarkup = connected.textContent;
  assert.match(connectedMarkup, /connectors\.policyOff/);
  assert.match(connectedMarkup, /connectors\.slack\.disconnect/);
  assert.equal(buttonWithText(connected, "connectors.slack.connect"), null);
  assert.doesNotMatch(connectedMarkup, /connectors\.slack\.reconnect/);
});

test("an org that turned connectors off hides the Slack row when there's no login", async (t) => {
  const none = await renderSection(t, { isPaid: true, blocked: true });
  assert.doesNotMatch(none.textContent, /connectors\.slack\.title/);
});

const GMAIL = {
  id: "gmail",
  connected: true,
  configured: true,
  accountLabel: "you@example.test",
  workspaceLabel: null,
  needsReconnect: false,
};
const pickerOption = (container, value) =>
  findElement(
    container,
    (node) => node.tagName === "SPAN" && node.getAttribute("data-value") === value
  );

test("Send from chat can be picked only while Gmail is connected", async (t) => {
  const container = await renderSection(t, { isPaid: true, statuses: { gmail: GMAIL } });
  const option = pickerOption(container, "gmailSend");
  assert.equal(option.textContent, "connectors.email.targets.gmailSend");
  assert.equal(option.getAttribute("data-disabled"), "false");
  // Automatic sends from chat once Gmail is connected.
  assert.match(
    container.textContent,
    /connectors\.email\.autoResolved\{"target":"connectors\.email\.targets\.gmailSend"\}/
  );
});

test("without a Gmail login, Send from chat is listed but can't be picked, and says why", async (t) => {
  const container = await renderSection(t, { isPaid: true });
  const option = pickerOption(container, "gmailSend");
  assert.equal(option.getAttribute("data-disabled"), "true");
  assert.equal(option.textContent, "connectors.email.targets.gmailSendConnectFirst");
  assert.match(
    container.textContent,
    /connectors\.email\.autoResolved\{"target":"connectors\.email\.targets\.outlookWork"\}/
  );
});

test("a Gmail login that needs reconnecting can't be picked, but Automatic still points at it", async (t) => {
  const container = await renderSection(t, {
    isPaid: true,
    statuses: { gmail: { ...GMAIL, needsReconnect: true } },
  });
  const option = pickerOption(container, "gmailSend");
  assert.equal(option.getAttribute("data-disabled"), "true");
  assert.equal(option.textContent, "connectors.email.targets.gmailSendConnectFirst");
  assert.match(
    container.textContent,
    /connectors\.email\.autoResolved\{"target":"connectors\.email\.targets\.gmailSend"\}/
  );
  assert.match(container.textContent, /connectors\.gmail\.needsReconnect/);
});

test("a build without a Google client shows no Gmail row and no Send from chat", async (t) => {
  const container = await renderSection(t, {
    isPaid: true,
    statuses: { gmail: { ...GMAIL, connected: false, configured: false, accountLabel: null } },
  });
  assert.doesNotMatch(container.textContent, /connectors\.gmail\./);
  // A boolean, so a failed assertion never tries to print a DOM node.
  assert.equal(Boolean(pickerOption(container, "gmailSend")), false);
  assert.ok(pickerOption(container, "gmail"), "the Gmail compose link stays");
});

const shownTarget = (container) =>
  findElement(container, (node) => Boolean(node.getAttribute?.("data-select-value")))?.getAttribute(
    "data-select-value"
  );

test("a saved Send from chat shows while Gmail can send, and reads as Automatic once it can't", async (t) => {
  for (const [label, statuses, expected] of [
    ["connected", { gmail: GMAIL }, "gmailSend"],
    ["needs reconnecting", { gmail: { ...GMAIL, needsReconnect: true } }, "gmailSend"],
    ["disconnected", {}, "auto"],
    [
      "build without a Google client",
      { gmail: { ...GMAIL, connected: false, configured: false, accountLabel: null } },
      "auto",
    ],
  ]) {
    await t.test(label, async (st) => {
      const container = await renderSection(st, {
        isPaid: true,
        statuses,
        emailDraftTarget: "gmailSend",
      });
      assert.equal(shownTarget(container), expected);
    });
  }
});

test("the card's description follows where drafts actually go", async (t) => {
  for (const [label, options, key] of [
    ["Automatic with Gmail connected", { statuses: { gmail: GMAIL } }, "descriptionSend"],
    [
      "a compose target picked",
      { statuses: { gmail: GMAIL }, emailDraftTarget: "mailto" },
      "description",
    ],
    ["no Gmail login", {}, "description"],
  ]) {
    await t.test(label, async (st) => {
      const container = await renderSection(st, { isPaid: true, ...options });
      const other = key === "description" ? "descriptionSend" : "description";
      assert.match(container.textContent, new RegExp(`connectors\\.email\\.${key}(?!Send)`));
      assert.doesNotMatch(
        container.textContent,
        new RegExp(`connectors\\.email\\.${other}(?!Send)`)
      );
    });
  }
});

test("any other saved target shows as saved", async (t) => {
  const container = await renderSection(t, { isPaid: true, emailDraftTarget: "mailto" });
  assert.equal(shownTarget(container), "mailto");
});

test("a connected Gmail row names the account", async (t) => {
  const container = await renderSection(t, { isPaid: true, statuses: { gmail: GMAIL } });
  assert.match(
    container.textContent,
    /connectors\.gmail\.connectedAs\{"account":"you@example\.test"\}/
  );
  assert.ok(buttonWithText(container, "connectors.gmail.disconnect"));
});

test("every CONNECTOR_ROWS entry renders after the email row, in list order", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { window: { electronAPI: {} } });
  setPlan(t, { usageState: usage(true) });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-connectors-section-row-order-test-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  const [{ ConnectorsSection }, { CONNECTOR_ROWS }] = await Promise.all([
    vite.ssrLoadModule("/components/ConnectorsSection.tsx"),
    vite.ssrLoadModule("/components/connectors/connectorRows.tsx"),
  ]);
  root = createRoot(container);
  await React.act(async () => root.render(createElement(ConnectorsSection, { onUpgrade() {} })));

  assert.ok(CONNECTOR_ROWS.length > 0, "there is at least one row to check");
  const markup = container.textContent;
  const emailIndex = markup.indexOf("connectors.email.title");
  assert.ok(emailIndex >= 0, "the email row renders");
  let previousIndex = emailIndex;
  for (const row of CONNECTOR_ROWS) {
    const index = markup.indexOf(`connectors.${row.id}.title`);
    assert.ok(index >= 0, `the ${row.id} row renders`);
    assert.ok(index > previousIndex, `the ${row.id} row renders after the previous row`);
    previousIndex = index;
  }
});
