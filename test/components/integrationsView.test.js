const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");

const { createElement } = React;
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { findElement, installInteractiveDom } = require("../lib/interactiveDom");

const MOCKS = {
  "react-i18next": `
    const t = (key) => key;
    export const useTranslation = () => ({ t, i18n: { language: "en" } });
  `,
  "/stores/settingsStore": `
    export function useSettingsStore(selector) {
      return selector({
        gcalAccounts: globalThis.__gcalAccounts ?? [],
        mcalAccounts: [],
        appleCalendarConnected: false,
      });
    }
  `,
  "/hooks/useConnectorAccess": `
    export function useConnectorAccess() {
      return globalThis.__connectorAccess;
    }
  `,
  "/stores/connectorStatusStore": `
    export function useConnectorStatusStore(selector) {
      return selector({ statuses: globalThis.__connectorStatuses ?? {} });
    }
    export async function ensureConnectorStatus() {}
  `,
  "/connectors/connectorRows": `
    export const CONNECTOR_ROWS = [{ id: "gmail" }, { id: "slack" }, { id: "linear" }, { id: "github" }];
  `,
  "/ConnectorsSection": `
    import React from "react";
    export function ConnectorsSection() {
      React.useEffect(() => {
        globalThis.__connectorsMounts += 1;
      }, []);
      return React.createElement("div", null, "CONNECTORS SECTION");
    }
  `,
  "/ApiKeysSection": `
    import React from "react";
    export default function ApiKeysSection({ createRequest }) {
      return React.createElement("div", null, "API KEYS SECTION create:" + createRequest);
    }
  `,
  "/integrations/CalendarsPane": `
    import React from "react";
    export function CalendarsPane() { return React.createElement("div", null, "CALENDARS PANE"); }
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
  "/ui/useToast": `
    export const useToast = () => ({ toast() {} });
  `,
};

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

const nav = (container) => findElement(container, (node) => node.tagName === "NAV");
const navButton = (container, section) =>
  findElement(
    nav(container),
    (node) =>
      node.tagName === "BUTTON" &&
      node.textContent.trim().startsWith(`integrations.nav.sections.${section}`)
  );
// Icons render whitespace text nodes, so labels are compared trimmed.
const label = (node) => node.textContent.trim();
// Sections stay mounted once opened; only the open one is shown.
const shownText = (node) => {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType === 1 && node.getAttribute("hidden") !== null) return "";
  return node.childNodes.map(shownText).join("");
};
// Focus checks compare as booleans: a failed assert would try to print the DOM.
const heading = (container, text) =>
  findElement(container, (node) => node.tagName === "H2" && label(node) === text);
const buttonWithText = (container, text) =>
  findElement(container, (node) => node.tagName === "BUTTON" && label(node) === text);

async function renderView(
  t,
  {
    isPaid = true,
    section = "connectors",
    statuses = {},
    gcalAccounts = [],
    connectorAccess = { isPaid, blockedByOrg: false, connectorsAllowed: true },
  } = {}
) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t, {
    window: { electronAPI: { getPlatform: () => "darwin", openExternal() {} } },
  });
  globalThis.__connectorStatuses = statuses;
  globalThis.__gcalAccounts = gcalAccounts;
  globalThis.__connectorAccess = connectorAccess;
  globalThis.__connectorsMounts = 0;
  t.after(() => {
    delete globalThis.__connectorStatuses;
    delete globalThis.__gcalAccounts;
    delete globalThis.__connectorAccess;
    delete globalThis.__connectorsMounts;
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-integrations-view-test-",
    noExternal: ["react-i18next"],
    mockModules: MOCKS,
  });
  const { default: IntegrationsView } = await vite.ssrLoadModule(
    "/components/IntegrationsView.tsx"
  );
  const upgrades = { count: 0 };
  function Harness() {
    const [current, setCurrent] = React.useState(section);
    return createElement(IntegrationsView, {
      isPaid,
      onUpgrade: () => upgrades.count++,
      section: current,
      onSectionChange: setCurrent,
    });
  }
  root = createRoot(container);
  await React.act(async () => root.render(createElement(Harness)));
  return { container, upgrades };
}

test("sectionMeta shows counts on a paid plan and plan badges on a free one", async (t) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-integrations-sections-test-",
  });
  const { sectionMeta } = await vite.ssrLoadModule(
    "/components/integrations/integrationsSections.ts"
  );
  const connectors = (isPaid, ready, blockedByOrg = false) => ({ isPaid, blockedByOrg, ready });
  const paid = { isPaid: true, connectors: connectors(true, 2), connectedCalendars: 1 };
  const free = { isPaid: false, connectors: connectors(false, 0), connectedCalendars: 1 };
  const empty = { isPaid: true, connectors: connectors(true, 0), connectedCalendars: 0 };

  assert.deepEqual(sectionMeta("connectors", paid), { kind: "count", value: 2 });
  assert.deepEqual(sectionMeta("calendars", paid), { kind: "count", value: 1 });
  assert.equal(sectionMeta("api", paid), null);
  assert.equal(sectionMeta("mcp", paid), null);
  assert.equal(sectionMeta("cli", paid), null);

  assert.deepEqual(sectionMeta("connectors", free), { kind: "badge", badge: "pro" });
  assert.deepEqual(sectionMeta("calendars", free), { kind: "count", value: 1 });
  assert.deepEqual(sectionMeta("api", free), { kind: "badge", badge: "pro" });
  assert.deepEqual(sectionMeta("mcp", free), { kind: "badge", badge: "pro" });
  assert.deepEqual(sectionMeta("cli", free), { kind: "badge", badge: "free" });

  assert.equal(sectionMeta("connectors", empty), null);
  assert.equal(sectionMeta("calendars", empty), null);

  // The organization turned connectors off: no plan badge and no count, on any plan.
  for (const isPaid of [true, false]) {
    const blocked = { ...paid, isPaid, connectors: connectors(isPaid, 2, true) };
    assert.equal(sectionMeta("connectors", blocked), null);
  }
});

test("the nav lists every section and switches the pane it shows", async (t) => {
  const { container } = await renderView(t);

  const order = [];
  findElement(nav(container), (node) => {
    if (node.tagName === "BUTTON" && label(node).startsWith("integrations.nav.sections.")) {
      order.push(label(node).replace(/^integrations\.nav\.sections\.([a-z]+).*$/, "$1"));
    }
    return false;
  });
  assert.deepEqual(order, ["calendars", "connectors", "api", "mcp", "cli"]);
  assert.equal(navButton(container, "connectors").getAttribute("aria-current"), "page");
  assert.match(container.textContent, /CONNECTORS SECTION/);

  await React.act(async () => click(navButton(container, "cli")));

  assert.equal(navButton(container, "cli").getAttribute("aria-current"), "page");
  assert.equal(navButton(container, "connectors").getAttribute("aria-current"), null);
  assert.doesNotMatch(shownText(container), /CONNECTORS SECTION/);
  assert.match(shownText(container), /npm install -g @openwhispr\/cli/);
});

test("a section keeps its state while another one is open", async (t) => {
  const { container } = await renderView(t);

  await React.act(async () => click(navButton(container, "api")));
  await React.act(async () => click(navButton(container, "connectors")));

  // A connect running in a connector row (GitHub's device code) would stop on unmount.
  assert.equal(globalThis.__connectorsMounts, 1);
  assert.match(shownText(container), /CONNECTORS SECTION/);
});

test("Calendars stays mounted from any section, so its listeners keep the nav count fresh", async (t) => {
  const { container } = await renderView(t, { section: "api" });

  assert.match(container.textContent, /CALENDARS PANE/);
  assert.doesNotMatch(shownText(container), /CALENDARS PANE/);
});

test("the section it's given opens first", async (t) => {
  const { container } = await renderView(t, { section: "calendars" });

  assert.equal(navButton(container, "calendars").getAttribute("aria-current"), "page");
  assert.match(shownText(container), /CALENDARS PANE/);
});

test("MCP's Create API key step opens the API keys section and asks it to create one", async (t) => {
  const { container } = await renderView(t, { section: "mcp" });

  await React.act(async () => click(buttonWithText(container, "apiKeysSection.createButton")));

  assert.equal(navButton(container, "api").getAttribute("aria-current"), "page");
  assert.match(shownText(container), /API KEYS SECTION create:1/);
  assert.equal(
    container.ownerDocument.activeElement === heading(container, "integrations.nav.sections.api"),
    true
  );
});

test("the API keys section links on to MCP and the command line", async (t) => {
  const { container } = await renderView(t, { section: "api" });

  const cliLink = findElement(
    container,
    (node) =>
      node.tagName === "BUTTON" &&
      node.textContent.trim() === "integrations.nav.sections.cli" &&
      !nav(container).contains(node)
  );
  await React.act(async () => click(cliLink));

  assert.equal(navButton(container, "cli").getAttribute("aria-current"), "page");
  // The link is hidden with its section, so focus moves to the opened one.
  assert.equal(
    container.ownerDocument.activeElement === heading(container, "integrations.nav.sections.cli"),
    true
  );
});

test("picking a section from the nav leaves focus on the nav", async (t) => {
  const { container } = await renderView(t);
  const cliButton = navButton(container, "cli");
  cliButton.focus();

  await React.act(async () => click(cliButton));

  assert.equal(container.ownerDocument.activeElement === cliButton, true);
});

test("a paid plan sees how many connectors and calendars are connected", async (t) => {
  const { container } = await renderView(t, {
    statuses: {
      gmail: { id: "gmail", connected: true },
      slack: { id: "slack", connected: true },
      linear: { id: "linear", connected: false },
      github: { id: "github", connected: true, needsReconnect: true },
    },
    gcalAccounts: [{ email: "a@acme.com" }],
  });

  assert.equal(label(navButton(container, "connectors")), "integrations.nav.sections.connectors2");
  assert.equal(label(navButton(container, "calendars")), "integrations.nav.sections.calendars1");
  assert.equal(label(navButton(container, "api")), "integrations.nav.sections.api");
});

test("the Connectors tag follows the plan check the Connectors pane uses", async (t) => {
  // Usage still loading: the page counts as paid, while connectors fall back to
  // the saved subscription flag, as the pane does.
  const { container } = await renderView(t, {
    isPaid: true,
    connectorAccess: { isPaid: false, blockedByOrg: false, connectorsAllowed: false },
  });

  assert.equal(
    label(navButton(container, "connectors")),
    "integrations.nav.sections.connectorsintegrations.plan.pro"
  );
  assert.equal(label(navButton(container, "api")), "integrations.nav.sections.api");
});

test("a free plan sees plan badges, the API upsell, and no key list", async (t) => {
  const { container, upgrades } = await renderView(t, { isPaid: false, section: "api" });

  assert.equal(
    label(navButton(container, "connectors")),
    "integrations.nav.sections.connectorsintegrations.plan.pro"
  );
  assert.equal(
    label(navButton(container, "mcp")),
    "integrations.nav.sections.mcpintegrations.plan.pro"
  );
  assert.equal(
    label(navButton(container, "cli")),
    "integrations.nav.sections.cliintegrations.cli.local.freeBadge"
  );
  assert.match(shownText(container), /integrations\.api\.proRequired/);
  assert.doesNotMatch(container.textContent, /API KEYS SECTION/);

  await React.act(async () => click(buttonWithText(container, "integrations.api.viewPlans")));
  assert.equal(upgrades.count, 1);
});

test("a free plan still sees MCP's setup steps, with Create API key disabled", async (t) => {
  const { container } = await renderView(t, { isPaid: false, section: "mcp" });

  assert.match(container.textContent, /integrations\.mcp\.proRequired/);
  assert.match(container.textContent, /https:\/\/mcp\.openwhispr\.com\/mcp/);
  assert.notEqual(
    buttonWithText(container, "apiKeysSection.createButton").getAttribute("disabled"),
    null
  );
});
