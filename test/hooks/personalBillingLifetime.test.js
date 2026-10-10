const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

test("billing callbacks reject old identities/replies and only publish valid browser returns", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    delete globalThis.__billing;
  });
  const events = new EventTarget();
  const calls = [],
    pending = [],
    opened = [];
  const state = (globalThis.__billing = {
    generation: 7,
    auth: { isLoaded: true, isSignedIn: true, user: { id: "A" } },
    loads: [],
    toasts: [],
  });
  const dispatch =
    (name) =>
    (...args) => {
      calls.push({ name, args });
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    };
  installBrowserGlobals(t, {
    window: {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      electronAPI: {
        cloudCheckout: dispatch("checkout"),
        cloudBillingPortal: dispatch("portal"),
        cloudSwitchPlan: dispatch("switch"),
        cloudPreviewSwitch: dispatch("preview"),
        openExternal: async (url, generation) => {
          opened.push({ url, generation });
          return { success: true };
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    noExternal: ["react-i18next"],
    mockModules: {
      "/useAuth": `export const useAuth = () => globalThis.__billing.auth;`,
      "/lib/auth": `export const withSessionRefresh = fn => fn();`,
      "/lib/authRequestContext": `export const getValidatedAuthGeneration = () => globalThis.__billing.generation; export const getBoundSessionGeneration = id => globalThis.__billing.auth.isSignedIn && id === globalThis.__billing.auth.user?.id ? globalThis.__billing.generation : null;`,
      "/lib/usageStore": `const state = {status: "success", data: {entitlementSources: {personal: false, workspaceIds: []}}}; export const getUsageState = () => state; export const subscribeUsage = () => () => {}; export const setUsageAccount = () => {}; export const loadUsage = async (_fn, opts) => globalThis.__billing.loads.push(Boolean(opts?.force)); export const retryUsage = async () => {}; export const watchForUpgrade = async () => {}; export const isPastDueUsage = () => false; export const storeBillingOf = () => null;`,
      "react-i18next": `const t = key => key; export const useTranslation = () => ({t});`,
      "/ui/useToast": `export const useToast = () => ({toast: value => globalThis.__billing.toasts.push(value)});`,
    },
  });
  const { useUsage } = await vite.ssrLoadModule("/hooks/useUsage.ts");
  const { useBillingPortal } = await vite.ssrLoadModule("/hooks/useBillingPortal.ts");
  let usage, portal;
  function Owner() {
    usage = useUsage();
    portal = useBillingPortal(usage);
    return null;
  }
  root = createRoot(container);
  const render = () =>
    React.act(async () =>
      root.render(React.createElement(Owner, { generation: state.generation }))
    );
  const opts = { plan: "annual", tier: "pro" };
  await render();
  const stalePortal = portal.openBillingPortal;
  state.generation++;
  await render();
  await React.act(async () => stalePortal());
  assert.deepEqual(
    state.toasts,
    [],
    "old portal callbacks cannot publish feedback for a new lease"
  );
  assert.deepEqual(calls, []);
  for (const method of ["openCheckout", "openBillingPortal", "switchPlan", "previewSwitchPlan"]) {
    const old = usage[method];
    state.generation++;
    assert.equal((await old(opts)).success, false);
    await render();
    const count = calls.length;
    let request;
    await React.act(async () => {
      request = usage[method](opts);
    });
    assert.equal(calls.length, count + 1);
    const args = calls.at(-1).args;
    assert.equal(args.at(-1), state.generation);
    state.generation++;
    state.auth = { ...state.auth, user: { id: "B" } };
    await render();
    await React.act(async () =>
      pending.at(-1).resolve({ success: true, url: "https://stripe.test/old" })
    );
    assert.equal((await request).success, false);
    assert.equal(usage.checkoutLoading, false);
    assert.deepEqual(opened, []);
    state.loads.length = 0;
    events.dispatchEvent(new Event("focus"));
    assert.deepEqual(state.loads, [], "stale replies cannot arm a return marker");
  }
  let request;
  await React.act(async () => {
    request = usage.openCheckout(opts);
  });
  await React.act(async () =>
    pending.at(-1).resolve({ success: true, url: "https://stripe.test/fresh" })
  );
  assert.equal((await request).success, true);
  assert.deepEqual(opened, [{ url: "https://stripe.test/fresh", generation: state.generation }]);
  events.dispatchEvent(new Event("focus"));
  assert.deepEqual(state.loads, [true]);
  // A newly mounted useUsage owner consumes the pending return-focus refresh the unmounted opener armed.
  let transfer;
  await React.act(async () => {
    transfer = usage.openCheckout(opts);
  });
  await React.act(async () =>
    pending.at(-1).resolve({ success: true, url: "https://stripe.test/transfer" })
  );
  assert.equal((await transfer).success, true);
  await React.act(async () => root.render(null));
  await render();
  state.loads.length = 0;
  events.dispatchEvent(new Event("focus"));
  assert.deepEqual(
    state.loads,
    [true],
    "a remaining owner consumes the checkout return refresh after its opener unmounted"
  );
  await React.act(async () => {
    request = usage.switchPlan(opts);
  });
  await React.act(async () => pending.at(-1).resolve({ success: true, alreadyOnPlan: false }));
  assert.equal((await request).success, true);
  assert.equal(state.loads.at(-1), true);
  await React.act(async () => {
    request = portal.openBillingPortal();
  });
  state.generation++;
  await React.act(async () => pending.at(-1).reject(new Error("fake refusal")));
  await request;
  assert.deepEqual(
    state.toasts,
    [],
    "obsolete portal errors cannot describe a replacement identity"
  );
  const portalCalls = calls.length;
  state.generation = null;
  await render();
  await React.act(async () => portal.openBillingPortal());
  assert.equal(calls.length, portalCalls, "an unvalidated session sends no portal request");
  assert.deepEqual(
    state.toasts.map((toast) => toast.title),
    ["settingsPage.account.billing.couldNotOpenTitle"],
    "an unvalidated session still gets feedback"
  );
  const signedInCallback = usage.openCheckout;
  state.generation = null;
  state.auth = { isLoaded: true, isSignedIn: false, user: null };
  await render();
  assert.equal(usage, null);
  assert.equal((await signedInCallback(opts)).success, false);
});
