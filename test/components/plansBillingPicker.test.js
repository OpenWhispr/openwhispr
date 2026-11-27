const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

const PERSONAL = "settingsPage.billing.picker.personal";
const LOAD_FAILED = "settingsPage.billing.picker.loadFailed";

const workspace = (id, name, plan = "free") => ({
  id,
  name,
  plan,
  status: "active",
  role: "owner",
  icon_url: null,
});

async function setup(t, storeOverrides = {}) {
  const cleanup = [];
  const context = { after: (callback) => cleanup.push(callback) };
  t.after(async () => {
    for (const callback of cleanup.reverse()) await callback();
  });
  const happyWindow = await installHappyDom(context);
  const state = {
    setActiveCalls: 0,
    refreshCalls: 0,
    store: {
      workspaces: [workspace("acme", "Acme", "business"), workspace("home", "Home")],
      defaultWorkspaceId: "home",
      activeWorkspaceId: "home",
      loaded: true,
      loading: false,
      error: false,
      ...storeOverrides,
    },
  };
  globalThis.__billingPickerTest = state;
  t.after(() => delete globalThis.__billingPickerTest);
  const vite = await createRendererServer(context, {
    noExternal: ["react-i18next"],
    cachePrefix: "openwhispr-plans-billing-picker-",
    mockModules: {
      "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
      "/hooks/useAuth":
        "export const useAuth = () => ({ isSignedIn: true, isOfflineAccount: false });",
      // The store's actions are stable functions, as zustand's are.
      "/stores/workspaceStore": `const refresh = async () => { globalThis.__billingPickerTest.refreshCalls++; };
        const setActive = () => { globalThis.__billingPickerTest.setActiveCalls++; };
        export const useWorkspaceStore = (select) =>
          select({ ...globalThis.__billingPickerTest.store, refresh, setActive });`,
      // Radix menus need pointer events happy-dom doesn't model; items become plain buttons.
      "/ui/dropdown-menu": `import React from "react";
        const h = React.createElement;
        const pass = ({ children }) => h(React.Fragment, null, children);
        export const DropdownMenu = pass;
        export const DropdownMenuContent = pass;
        export const DropdownMenuTrigger = ({ children }) => h("div", { "data-trigger": "" }, children);
        export const DropdownMenuItem = ({ children, onSelect }) =>
          h("button", { type: "button", role: "menuitem", onClick: () => onSelect?.({ preventDefault() {} }) }, children);
        export const DropdownMenuLabel = ({ children }) => h("div", null, children);
        export const DropdownMenuSeparator = () => h("hr");`,
      "/WorkspaceSwitcher": `import React from "react";
        export const RetryMenuItem = ({ message, onRetry }) =>
          React.createElement("button", { type: "button", "data-retry": "", onClick: onRetry }, message);`,
      "/MemberAvatar": "export default function MemberAvatar() { return null; }",
    },
  });
  const { PlansBillingPicker } = await vite.ssrLoadModule(
    "/components/settings/billing/PlansBillingPicker.tsx"
  );
  const { createRoot } = require("react-dom/client");
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(container);
  const root = createRoot(container);
  context.after(() => React.act(() => root.unmount()));
  const changes = [];
  const render = (request = { kind: "personal" }) =>
    React.act(async () =>
      root.render(
        React.createElement(PlansBillingPicker, {
          request,
          onChange: (next) => changes.push(next),
          personalPlanLabel: "Pro",
        })
      )
    );
  const clickRow = (label) =>
    React.act(async () => {
      const row = [...container.querySelectorAll('[role="menuitem"]')].find((candidate) =>
        candidate.textContent.includes(label)
      );
      assert.equal(Boolean(row), true, `Missing row ${label}`);
      row.click();
    });
  return { state, container, render, clickRow, changes, text: () => container.textContent };
}

test("picking a workspace changes the view and never the active workspace", async (t) => {
  const { state, render, clickRow, changes } = await setup(t);
  await render();
  await clickRow("Acme");
  assert.deepEqual(changes, [{ kind: "workspace", workspaceId: "acme" }]);
  assert.equal(state.setActiveCalls, 0);
});

test("picking Personal changes the view only", async (t) => {
  const { state, render, clickRow, changes } = await setup(t);
  await render({ kind: "workspace", workspaceId: "acme" });
  await clickRow(PERSONAL);
  assert.deepEqual(changes, [{ kind: "personal" }]);
  assert.equal(state.setActiveCalls, 0);
});

test("rows list Personal with its plan, then the default workspace first, each with its plan", async (t) => {
  const { container, render, text } = await setup(t);
  await render();
  const rows = [...container.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent);
  assert.deepEqual(rows, [
    `${PERSONAL}Pro`,
    "HomesettingsPage.workspace.billing.planLabel.free",
    "AcmesettingsPage.workspace.billing.planLabel.business",
  ]);
  assert.equal(text().includes("settingsPage.billing.picker.workspaces"), true);
});

test("the trigger names the viewed workspace", async (t) => {
  const { container, render } = await setup(t);
  await render({ kind: "workspace", workspaceId: "acme" });
  assert.equal(container.querySelector("[data-trigger]").textContent.includes("Acme"), true);
});

test("a failed list offers retry and keeps Personal", async (t) => {
  const { state, container, render, text } = await setup(t, {
    loaded: true,
    error: true,
    workspaces: [],
  });
  await render();
  assert.ok(text().includes(LOAD_FAILED));
  assert.ok(text().includes(PERSONAL));
  await React.act(async () => container.querySelector("[data-retry]").click());
  assert.equal(state.refreshCalls, 1);
});

test("a failed refresh keeps the cached rows below the retry", async (t) => {
  const { render, text } = await setup(t, { error: true });
  await render();
  const content = text();
  assert.equal(content.includes(LOAD_FAILED), true);
  assert.equal(content.indexOf(LOAD_FAILED) < content.indexOf("Acme"), true);
});

test("an unloaded list asks for it once", async (t) => {
  const { state, render, container } = await setup(t, { loaded: false, workspaces: [] });
  await render();
  await render();
  assert.equal(state.refreshCalls, 1);
  assert.equal(container.querySelectorAll("[data-billing-picker-skeleton]").length, 1);
});

test("a loaded list without the requested workspace shows the neutral label, not a pulse", async (t) => {
  const { container, render } = await setup(t, { loaded: true, error: true, workspaces: [] });
  await render({ kind: "workspace", workspaceId: "gone" });
  const trigger = container.querySelector("[data-trigger]");
  assert.equal(trigger.textContent.includes("settingsPage.billing.picker.workspaces"), true);
  assert.equal(trigger.querySelectorAll(".animate-pulse").length, 0);
});

test("an unloaded list still pulses while the requested workspace is unknown", async (t) => {
  const { container, render } = await setup(t, { loaded: false, workspaces: [] });
  await render({ kind: "workspace", workspaceId: "gone" });
  assert.equal(container.querySelector("[data-trigger] .animate-pulse") !== null, true);
});
