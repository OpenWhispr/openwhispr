const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRendererServer, installHappyDom } = require("../lib/rendererTestHarness");

async function setup(t, { loading = false } = {}) {
  const cleanup = [];
  const context = { after: (callback) => cleanup.push(callback) };
  t.after(async () => {
    for (const callback of cleanup.reverse()) await callback();
  });
  const happyWindow = await installHappyDom(context);
  const state = { refreshCalls: 0, cards: [], loading };
  globalThis.__billingViewTest = state;
  t.after(() => delete globalThis.__billingViewTest);
  const vite = await createRendererServer(context, {
    noExternal: ["react-i18next"],
    cachePrefix: "openwhispr-workspace-billing-view-",
    mockModules: {
      "react-i18next": "export const useTranslation = () => ({ t: (key) => key });",
      "/stores/workspaceStore": `export const useWorkspaceStore = (select) => select({
        loading: globalThis.__billingViewTest.loading,
        refresh: async () => { globalThis.__billingViewTest.refreshCalls++; }
      });`,
      "/WorkspaceBillingCard": `import React from "react";
        export default function WorkspaceBillingCard(props) {
          globalThis.__billingViewTest.cards.push({
            id: props.workspace.id,
            onViewPersonal: props.onViewPersonal,
          });
          return React.createElement("div", { "data-card": props.workspace.id });
        }`,
    },
  });
  const { WorkspaceBillingView } = await vite.ssrLoadModule(
    "/components/settings/billing/WorkspaceBillingView.tsx"
  );
  const { createRoot } = require("react-dom/client");
  const container = happyWindow.document.createElement("div");
  happyWindow.document.body.appendChild(container);
  const root = createRoot(container);
  context.after(() => React.act(() => root.unmount()));
  const onViewPersonal = () => {};
  const render = (view) =>
    React.act(async () =>
      root.render(React.createElement(WorkspaceBillingView, { view, onViewPersonal }))
    );
  return { state, container, render, onViewPersonal };
}

test("workspaceLoading shows a skeleton and no buttons", async (t) => {
  const { container, render } = await setup(t);
  await render({ kind: "workspaceLoading", workspaceId: "acme" });
  assert.equal(container.querySelectorAll("button").length, 0);
  assert.equal(container.querySelectorAll(".animate-pulse").length, 2);
});

test("workspaceUnavailable explains and Retry refreshes the store", async (t) => {
  const { state, container, render } = await setup(t);
  await render({ kind: "workspaceUnavailable", workspaceId: "acme" });
  const text = container.textContent;
  assert.equal(text.includes("settingsPage.billing.workspaceUnavailable.title"), true);
  assert.equal(text.includes("settingsPage.billing.workspaceUnavailable.description"), true);
  const buttons = container.querySelectorAll("button");
  assert.equal(buttons.length, 1);
  await React.act(async () => buttons[0].click());
  assert.equal(state.refreshCalls, 1);
});

test("workspace renders its card with the workspace id and the Personal handler", async (t) => {
  const { state, container, render, onViewPersonal } = await setup(t);
  await render({ kind: "workspace", workspace: { id: "acme", name: "Acme" } });
  assert.equal(container.querySelectorAll('[data-card="acme"]').length, 1);
  const last = state.cards[state.cards.length - 1];
  assert.equal(last.id, "acme");
  assert.equal(last.onViewPersonal === onViewPersonal, true);
});

test("switching workspace mounts a fresh card", async (t) => {
  const { container, render } = await setup(t);
  await render({ kind: "workspace", workspace: { id: "a", name: "A" } });
  await render({ kind: "workspace", workspace: { id: "b", name: "B" } });
  assert.equal(container.querySelectorAll('[data-card="a"]').length, 0);
  assert.equal(container.querySelectorAll('[data-card="b"]').length, 1);
});
