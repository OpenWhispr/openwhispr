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

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const workspace = {
  id: "ws-1",
  name: "First",
  role: "owner",
  seats: 2,
  seats_used: 2,
  plan: "business",
  status: "active",
  stripe_customer_id: "customer-1",
  stripe_subscription_id: "sub-1",
  current_period_end: "2026-11-01",
  trial_ends_at: null,
  cancel_at_period_end: false,
};
const quote = (current = workspace) => ({
  current_quantity: current.seats,
  seats_used: current.seats_used ?? 1,
  next_quantity: current.seats + 1,
  amount_due: 1500,
  currency: "usd",
});

test("seat confirmations belong to the current billing snapshot and request", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__seatTest;
  });
  installBrowserGlobals(t);
  const container = installHostDom(t);
  const state = (globalThis.__seatTest = {
    buttons: [],
    dialogs: [],
    previews: [],
    updates: [],
    toasts: [],
    refreshes: 0,
    entitlementRefreshes: 0,
    returnArms: 0,
    consoleMounts: 0,
  });
  state.store = create(() => ({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    loaded: true,
    error: false,
    refresh: async () => {
      state.refreshes++;
      if (state.refreshedWorkspace)
        state.store.setState({ workspaces: [state.refreshedWorkspace] });
    },
  }));
  state.service = {
    previewSeats: (id, additional) => {
      const pending = deferred();
      state.previews.push({ id, additional, ...pending });
      return pending.promise;
    },
    updateSeats: async (id, quantity) => {
      state.updates.push({ id, quantity });
      if (state.updatePending) await state.updatePending.promise;
    },
    billingPortal: async () => "https://stripe.test/portal",
  };
  globalThis.window.electronAPI.openExternal = async (url) => (state.openedUrl = url);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-seat-confirmation-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `const t = (key, options) => options?.count != null ? key + ":" + options.count : key; export const useTranslation = () => ({t});`,
      "/stores/workspaceStore": `export const useWorkspaceStore = globalThis.__seatTest.store;`,
      "/services/WorkspacesService": `export const WorkspacesService = globalThis.__seatTest.service;`,
      "/components/icons": `export const ExternalLink = () => null; export const Plus = () => null; export const Loader2 = () => null;`,
      "/ui/useToast": `export const useToast = () => ({toast: value => globalThis.__seatTest.toasts.push(value)});`,
      "/ui/button": `import React from "react"; export const Button = ({children, size, variant, ...props}) => { globalThis.__seatTest.buttons.push({label: React.Children.toArray(children).filter(child => typeof child === "string").join(""), ...props}); return React.createElement("button", props, children); };`,
      "/ui/dialog": `
        import React from "react";
        export const Dialog = ({open, onOpenChange, children}) => { globalThis.__seatTest.dialogs.push({open, onOpenChange}); return open ? React.createElement("div", null, children) : null; };
        const Wrapper = ({children}) => React.createElement("div", null, children);
        export const DialogContent = Wrapper; export const DialogHeader = Wrapper;
        export const DialogTitle = Wrapper; export const DialogDescription = Wrapper; export const DialogFooter = Wrapper;
      `,
      "/EnterpriseConsoleRow": `import React from "react"; export default function Console() { React.useEffect(() => { globalThis.__seatTest.consoleMounts++; }, []); return null; }`,
      "/hooks/useBillingRefreshOnReturn": `export const useBillingRefreshOnReturn = callback => () => { globalThis.__seatTest.returnArms++; globalThis.__seatTest.onReturn = callback; };`,
    },
  });
  const { default: Overview } = await vite.ssrLoadModule(
    "/components/settings/WorkspaceBillingOverview.tsx"
  );
  root = createRoot(container);
  const render = async () =>
    React.act(async () =>
      root.render(
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(Overview, {
            onRefreshEntitlement: async () => state.entitlementRefreshes++,
          })
        )
      )
    );
  await render();
  const button = (key) => state.buttons.findLast((b) => b.label === key);
  const add = () => button("settingsPage.unifiedBilling.addSeat");
  const confirm = () => button("settingsPage.unifiedBilling.confirmSeats.confirm");
  const dialog = () => state.dialogs.at(-1);
  const publish = (next) => React.act(async () => state.store.setState({ workspaces: [next] }));
  const requestQuote = async () => {
    assert.equal(add().disabled, false);
    await React.act(async () => add().onClick());
    assert.equal(add().disabled, true);
    return state.previews.at(-1);
  };
  const resolve = (pending, value) => React.act(async () => pending.resolve(value));

  await t.test(
    "same-workspace capacity refresh closes the dialog without resurrecting the quote",
    async () => {
      await resolve(await requestQuote(), quote());
      assert.equal(dialog().open, true);
      await publish({ ...workspace, seats: 5 });
      assert.equal(dialog().open, false);
      await publish(workspace);
      assert.equal(
        dialog().open,
        false,
        "returning to the old snapshot cannot resurrect the quote"
      );
    }
  );

  await t.test("occupancy and eligibility changes invalidate open and pending quotes", async () => {
    for (const change of [
      { seats_used: 1 },
      { role: "admin" },
      { status: "past_due" },
      { stripe_subscription_id: null },
    ]) {
      await resolve(await requestQuote(), quote());
      assert.equal(dialog().open, true);
      await publish({ ...workspace, ...change });
      assert.equal(dialog().open, false, JSON.stringify(change));
      await publish(workspace);
      const pending = await requestQuote();
      await publish({ ...workspace, ...change });
      await publish(workspace);
      await resolve(pending, quote());
      assert.equal(dialog().open, false, "late preview must stay invalidated");
      assert.equal(add().disabled, false, "old loading completion cannot leave the card stuck");
    }
    assert.deepEqual(state.updates, []);
  });

  await t.test(
    "metadata-only refresh retains a quote without remounting billing children",
    async () => {
      const mounts = state.consoleMounts;
      await resolve(await requestQuote(), quote());
      await publish({ ...workspace, name: "Renamed", updated_at: "new" });
      assert.equal(dialog().open, true);
      assert.equal(state.consoleMounts, mounts);
      await React.act(async () => dialog().onOpenChange(false));
      await publish(workspace);
    }
  );

  await t.test(
    "reordered successes, errors and loading completions cannot replace a newer quote",
    async () => {
      const old = await requestQuote();
      const newerWorkspace = { ...workspace, seats: 4 };
      await publish(newerWorkspace);
      const newer = await requestQuote();
      await resolve(old, quote());
      assert.equal(add().disabled, true, "old finally must not clear newer loading");
      await resolve(newer, quote(newerWorkspace));
      assert.equal(dialog().open, true);
      assert.match(container.textContent, /confirmSeats.description:5/);
      await React.act(async () => dialog().onOpenChange(false));
      const failed = await requestQuote();
      await publish(workspace);
      await resolve(await requestQuote(), quote());
      const toasts = state.toasts.length;
      await React.act(async () => failed.reject(new Error("old failure")));
      assert.equal(state.toasts.length, toasts);
      assert.equal(dialog().open, true);
      await React.act(async () => button("common.cancel").onClick());
      assert.equal(dialog().open, false);
    }
  );

  await t.test(
    "a preview newer than the known capacity or occupancy refreshes instead of confirming",
    async () => {
      for (const mismatch of [{ current_quantity: 8 }, { seats_used: 1 }]) {
        const refreshes = state.refreshes;
        await resolve(await requestQuote(), { ...quote(), ...mismatch });
        assert.equal(dialog().open, false);
        assert.equal(state.refreshes, refreshes + 1);
        assert.equal(add().disabled, false);
      }
      const pending = await requestQuote();
      await React.act(async () => pending.reject(new Error("current failure")));
      assert.equal(state.toasts.at(-1).variant, "destructive");
      assert.equal(add().disabled, false);
    }
  );

  await t.test(
    "cancel/reopen uses a fresh quote and submits exactly its absolute quantity",
    async () => {
      await resolve(await requestQuote(), quote());
      await React.act(async () => button("common.cancel").onClick());
      await resolve(await requestQuote(), quote());
      state.updatePending = deferred();
      await React.act(async () => confirm().onClick());
      assert.deepEqual(state.updates, [{ id: "ws-1", quantity: 3 }]);
      assert.equal(confirm().disabled, true);
      await publish({ ...workspace, role: "member" });
      const refreshes = state.refreshes;
      await resolve(state.updatePending);
      assert.equal(
        state.refreshes,
        refreshes + 1,
        "a completed write still reconciles the shared store"
      );
      state.updatePending = null;
      await publish(workspace);
    }
  );

  await t.test(
    "unmount/close discards pending quotes and fresh owners hydrate independently",
    async () => {
      const pending = await requestQuote();
      await React.act(async () => root.unmount());
      root = null;
      const toasts = state.toasts.length;
      await React.act(async () => pending.reject(new Error("closed owner")));
      assert.equal(state.toasts.length, toasts);
      root = createRoot(container);
      await render();
      assert.equal(dialog().open, false);
      await resolve(await requestQuote(), quote());
      assert.equal(dialog().open, true);
    }
  );
});
