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
      emailDraftTarget: globalThis.__emailDraftTarget ?? "auto",
      setEmailDraftTarget() {},
      gcalConnected: false,
      mcalAccounts: [{ email: "a@corp.com", tenantId: null }],
    };
    export function useSettingsStore(selector) { return selector(state); }
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

const SLACK = {
  id: "slack",
  connected: true,
  accountLabel: "chad",
  workspaceLabel: "Acme Test",
  needsReconnect: false,
};
// This harness's DOM nodes only expose textContent (no innerHTML), so a plain
// string like "connectors.slack.connect" can't be told apart from a longer
// key that starts with it ("connectors.slack.connecting",
// "…connectedAs"). Finding the actual <button> is unambiguous.
const buttonWithText = (container, text) =>
  findElement(container, (node) => node.tagName === "BUTTON" && node.textContent === text);

// An org block is a resolved policy that disallows connectors, so it implies
// not allowed; `allowed: false` alone is a policy that is loading or failed.
function setConnectorState(
  t,
  { blocked = false, allowed = !blocked, statuses = {}, emailDraftTarget } = {}
) {
  globalThis.__emailDraftTarget = emailDraftTarget;
  globalThis.__connectorsBlocked = blocked;
  globalThis.__connectorsAllowed = allowed;
  globalThis.__connectorStatuses = statuses;
  t.after(() => {
    delete globalThis.__emailDraftTarget;
    delete globalThis.__connectorsBlocked;
    delete globalThis.__connectorsAllowed;
    delete globalThis.__connectorStatuses;
  });
}

async function renderSection(t, state, electronAPI = {}) {
  // Registered first so it runs before the globals it needs are torn down.
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, { window: { electronAPI } });
  setConnectorState(t, state);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-connectors-section-test-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  const { ConnectorsSection } = await vite.ssrLoadModule("/components/ConnectorsSection.tsx");
  root = createRoot(container);
  await React.act(async () => root.render(createElement(ConnectorsSection)));
  return container;
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

test("every plan chooses where drafts open, with nothing asking for a plan", async (t) => {
  const { textContent } = await renderSection(t);
  assert.match(textContent, /connectors\.email\.title/);
  assert.match(textContent, /connectors\.email\.targets\.gmail/);
  assert.match(textContent, /connectors\.email\.description/);
  assert.doesNotMatch(textContent, /integrations\.api\.viewPlans/);
});

test("automatic names the app it resolved to", async (t) => {
  const { textContent } = await renderSection(t);
  assert.match(
    textContent,
    /connectors\.email\.automaticHint\{"target":"connectors\.email\.targets\.outlookWork"\}/
  );
});

test("an org that turned connectors off sees why, under the card's header", async (t) => {
  const { textContent } = await renderSection(t, { blocked: true });
  assert.match(textContent, /connectors\.email\.title/);
  assert.match(textContent, /connectors\.policyOff/);
  assert.doesNotMatch(textContent, /connectors\.email\.targets/);
  assert.doesNotMatch(textContent, /integrations\.api\.viewPlans/);
});

test("while the policy is unresolved, the card says drafts are unavailable", async (t) => {
  let fetches = 0;
  const container = await renderSection(
    t,
    { allowed: false },
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

test("Connectors shows no recent actions or receipt content and never fetches history", async (t) => {
  let fetches = 0;
  const container = await renderSection(
    t,
    { statuses: { slack: SLACK, gmail: { ...SLACK, id: "gmail" } } },
    {
      connectorRecentActions: async () => {
        fetches++;
        return [receipt("a", "hidden@example.test")];
      },
    }
  );
  assert.equal(fetches, 0);
  assert.doesNotMatch(container.textContent, /connectors\.recent|hidden@example\.test/);
  assert.ok(buttonWithText(container, "connectors.slack.disconnect"));
});

test("a connected Slack shows the account and Disconnect", async (t) => {
  const container = await renderSection(t, {
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
test("a disconnected Slack offers Connect, and nothing asks for a plan", async (t) => {
  const disconnected = await renderSection(t, { blocked: false });
  assert.ok(buttonWithText(disconnected, "connectors.slack.connect"));
  assert.match(disconnected.textContent, /connectors\.slack\.description/);
  assert.doesNotMatch(disconnected.textContent, /integrations\.api\.viewPlans/);
  // The beta badge sits on the Connectors title, not on each row.
  assert.doesNotMatch(disconnected.textContent, /connectors\.beta/);
});

test("a stale login offers Reconnect and Disconnect", async (t) => {
  const stale = await renderSection(t, {
    blocked: false,
    statuses: { slack: { ...SLACK, needsReconnect: true } },
  });
  const staleMarkup = stale.textContent;
  assert.match(staleMarkup, /connectors\.slack\.reconnect/);
  assert.match(staleMarkup, /connectors\.slack\.disconnect/);
  assert.match(staleMarkup, /connectors\.slack\.needsReconnect/);
});

test("an org that turned connectors off still lets the user remove a login", async (t) => {
  const connected = await renderSection(t, {
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
  const none = await renderSection(t, { blocked: true });
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
  const container = await renderSection(t, { statuses: { gmail: GMAIL } });
  const option = pickerOption(container, "gmailSend");
  assert.equal(option.textContent, "connectors.email.targets.gmailSend");
  assert.equal(option.getAttribute("data-disabled"), "false");
  // Automatic sends from chat once Gmail is connected.
  assert.match(
    container.textContent,
    /connectors\.email\.automaticHint\{"target":"connectors\.email\.targets\.gmailSend"\}/
  );
});

test("without a Gmail login, Send from chat is listed but can't be picked, and says why", async (t) => {
  const container = await renderSection(t);
  const option = pickerOption(container, "gmailSend");
  assert.equal(option.getAttribute("data-disabled"), "true");
  assert.equal(option.textContent, "connectors.email.targets.gmailSendConnectFirst");
  assert.match(
    container.textContent,
    /connectors\.email\.automaticHint\{"target":"connectors\.email\.targets\.outlookWork"\}/
  );
});

test("a Gmail login that needs reconnecting can't be picked, but Automatic still points at it", async (t) => {
  const container = await renderSection(t, {
    statuses: { gmail: { ...GMAIL, needsReconnect: true } },
  });
  const option = pickerOption(container, "gmailSend");
  assert.equal(option.getAttribute("data-disabled"), "true");
  assert.equal(option.textContent, "connectors.email.targets.gmailSendConnectFirst");
  assert.match(
    container.textContent,
    /connectors\.email\.automaticHint\{"target":"connectors\.email\.targets\.gmailSend"\}/
  );
  assert.match(container.textContent, /connectors\.gmail\.needsReconnect/);
});

test("a build without a Google client shows no Gmail row and no Send from chat", async (t) => {
  const container = await renderSection(t, {
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
      const container = await renderSection(st, { ...options });
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
  const container = await renderSection(t, { emailDraftTarget: "mailto" });
  assert.equal(shownTarget(container), "mailto");
});

test("a connected Gmail row names the account", async (t) => {
  const container = await renderSection(t, { statuses: { gmail: GMAIL } });
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
  setConnectorState(t);
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
  await React.act(async () => root.render(createElement(ConnectorsSection)));

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

test("Automatic is initially selected and has a short label separate from its current target", async (t) => {
  const container = await renderSection(t);
  assert.equal(shownTarget(container), "auto");
  assert.equal(pickerOption(container, "auto").textContent, "connectors.email.targets.auto");
});
