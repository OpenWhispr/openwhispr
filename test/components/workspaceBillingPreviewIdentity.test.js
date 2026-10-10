const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { create } = require("zustand");
const {
  createRendererServer,
  installBrowserGlobals,
  installHostDom,
} = require("../lib/rendererTestHarness");

const workspace = {
  id: "one",
  name: "First",
  role: "owner",
  seats: 2,
  seats_used: 2,
  plan: "business",
  status: "active",
  stripe_customer_id: "customer",
  stripe_subscription_id: "sub",
  current_period_end: "2026-11-01",
  trial_ends_at: null,
  cancel_at_period_end: false,
};
const quote = {
  prorated_amount: 1500,
  currency: "usd",
  quantity: 2,
  interval: "monthly",
  next_billing_date: null,
};

test("mounted Enterprise quotes follow billing snapshots, request/session order and live eligibility", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__upgrade;
  });
  installBrowserGlobals(t);
  const container = installHostDom(t);
  const state = (globalThis.__upgrade = {
    buttons: [],
    previews: [],
    upgrades: [],
    toasts: [],
    refreshes: 0,
    open: true,
  });
  state.store = create(() => ({ workspaces: [workspace], refresh: async () => state.refreshes++ }));
  state.service = {
    previewEnterpriseUpgrade: (id) =>
      new Promise((resolve, reject) => state.previews.push({ id, resolve, reject })),
    upgradeToEnterprise: async (id) => state.upgrades.push(id),
  };
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = key => key; export const useTranslation = () => ({t});`,
      "/stores/workspaceStore": `export const useWorkspaceStore = globalThis.__upgrade.store;`,
      "/services/WorkspacesService": `export const WorkspacesService = globalThis.__upgrade.service;`,
      "/ui/useToast": `export const useToast = () => ({toast: value => globalThis.__upgrade.toasts.push(value)});`,
      "/hooks/useBillingRefreshOnReturn": `export const useBillingRefreshOnReturn = () => () => {};`,
      "/ui/button": `import React from "react"; export const Button = props => {globalThis.__upgrade.buttons.push(props); return React.createElement("button", {disabled: props.disabled, onClick: props.onClick}, props.children);};`,
      "/ui/dialog": `import React from "react"; export const Dialog = props => props.open ? props.children : null; export const DialogContent = ({children}) => React.createElement("div", null, children); export const DialogHeader = DialogContent; export const DialogTitle = DialogContent; export const DialogDescription = DialogContent; export const DialogFooter = DialogContent;`,
      "/ui/select": `export const Select = () => null; export const SelectContent = Select; export const SelectItem = Select; export const SelectTrigger = Select; export const SelectValue = Select;`,
    },
  });
  const { default: Checkout } = await vite.ssrLoadModule(
    "/components/settings/EnterpriseCheckoutDialog.tsx"
  );
  function Owner() {
    const workspaces = state.store((s) => s.workspaces);
    return React.createElement(Checkout, {
      workspaces,
      open: state.open,
      onOpenChange: (value) => (state.open = value),
    });
  }
  root = createRoot(container);
  const render = (open) =>
    React.act(async () => {
      state.open = open;
      root.render(React.createElement(React.StrictMode, null, React.createElement(Owner)));
    });
  const publish = (change) =>
    React.act(async () => state.store.setState({ workspaces: [{ ...workspace, ...change }] }));
  const preview = () => state.previews.at(-1);
  const cta = () =>
    state.buttons.findLast((b) =>
      React.Children.toArray(b.children).includes("settingsPage.enterpriseCheckout.upgradeCta")
    );
  const resolve = (pending) => React.act(async () => pending.resolve(quote));
  await render(true);
  const probe = state.previews[0];
  await resolve(preview());
  assert.equal(cta().disabled, false);
  await React.act(async () => probe.reject(new Error("obsolete StrictMode preview")));
  assert.equal(cta().disabled, false);
  const initialReads = state.previews.length;
  await publish({ name: "Renamed", updated_at: "new" });
  assert.equal(state.previews.length, initialReads, "metadata does not discard a valid quote");
  assert.equal(cta().disabled, false);

  for (const change of [{ seats: 3 }, { seats_used: 1 }]) {
    await publish(change);
    assert.equal(cta().disabled, true, JSON.stringify(change));
    const old = preview();
    await publish({});
    const fresh = preview();
    await resolve(old);
    assert.equal(cta().disabled, true, "A→B→A cannot revive an old pending quote");
    await resolve(fresh);
    assert.equal(cta().disabled, false);
  }
  await publish({ role: "admin" });
  assert.equal(container.textContent.includes("proratedCharge"), false);
  await publish({});
  const cancelled = preview();
  await render(false);
  await render(true);
  await resolve(cancelled);
  assert.equal(cta().disabled, true);
  await resolve(preview());
  assert.equal(cta().disabled, false);
  await React.act(async () => cta().onClick());
  assert.deepEqual(state.upgrades, ["one"]);
  assert.equal(state.refreshes, 1);
  assert.equal(state.open, false);
});
