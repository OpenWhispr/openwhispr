const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");
const { deferred } = require("../helpers/harness/deferred");

async function setup(t) {
  const cleanup = [];
  const context = { after: (callback) => cleanup.push(callback) };
  t.after(async () => {
    for (const callback of cleanup.reverse()) await callback();
  });
  const state = {
    generation: 7,
    status: async () => ({ data: { persisted: false, status: null } }),
    checkout: async () => ({ success: true, url: "https://checkout.stripe.com/test" }),
    checkouts: [],
    opened: [],
  };
  globalThis.__affiliateCheckout = state;
  t.after(() => delete globalThis.__affiliateCheckout);
  installBrowserGlobals(context, {
    window: {
      electronAPI: {
        getAffiliateCandidate: async () => ({
          config: { domain: "try.openwhispr.com" },
          candidate: null,
          generation: state.generation,
        }),
        cloudCheckout: async (...args) => {
          state.checkouts.push(args);
          return state.checkout();
        },
        openExternal: async (url) => state.opened.push(url),
      },
    },
  });
  const container = installHookDom(context);
  const vite = await createRendererServer(context, {
    mockModules: {
      "/useAuth": `export const useAuth=()=>({isLoaded:true,isSignedIn:true,user:{id:'a'}});`,
      "/lib/auth": `export const withSessionRefresh=async(fn)=>fn();`,
      "/lib/authRequestContext": `export const getValidatedAuthGeneration=()=>globalThis.__affiliateCheckout.generation; export const hasValidatedAuthContext=()=>globalThis.__affiliateCheckout.generation!==null; export const getAuthRequestContextSnapshot=()=>({observedGeneration:globalThis.__affiliateCheckout.generation}); export const subscribeAuthRequestContext=()=>()=>{};`,
      "/lib/usageStore": `const state={status:'success',accountId:'a',data:{plan:'free',wordsUsed:0,limit:2000,isSubscribed:false,isTrial:false,entitlementSources:{personal:false,workspaceIds:[]}}}; export const subscribeUsage=()=>()=>{}; export const getUsageState=()=>state; export const setUsageAccount=()=>{}; export const loadUsage=async()=>{}; export const retryUsage=async()=>{}; export const watchForUpgrade=async()=>{}; export const isPastDueUsage=()=>false; export const storeBillingOf=()=>null;`,
      settingsStore: `export const useSettingsStore={getState:()=>({telemetryEnabled:false})};`,
      "/services/cloudApi": `export const cloudGetForAuthGeneration=()=>globalThis.__affiliateCheckout.status(); export const cloudPostForAuthGeneration=async()=>({});`,
    },
  });
  const { useUsage } = await vite.ssrLoadModule("/hooks/useUsage.ts");
  let usage;
  function Harness() {
    usage = useUsage();
    return null;
  }
  const root = createRoot(container);
  context.after(() => React.act(async () => root.unmount()));
  await React.act(async () => root.render(React.createElement(Harness)));
  return { state, usage };
}

test("checkout rejects an account switch during referral preparation", async (t) => {
  const { state, usage } = await setup(t);
  const pending = deferred();
  const entered = deferred();
  state.status = () => {
    entered.resolve();
    return pending.promise;
  };
  await React.act(async () => {
    const checkout = usage.openCheckout({ plan: "monthly", tier: "pro" });
    await entered.promise;
    state.generation++;
    pending.resolve({ data: { persisted: false, status: null } });
    assert.equal((await checkout).success, false);
  });
  assert.deepEqual(state.checkouts, []);
  assert.deepEqual(state.opened, []);
});

test("checkout carries the validated generation to the native request", async (t) => {
  const { state, usage } = await setup(t);
  await React.act(async () =>
    assert.equal((await usage.openCheckout({ plan: "annual" })).success, true)
  );
  assert.deepEqual(state.checkouts, [[{ plan: "annual" }, 7]]);
  assert.equal(state.opened.length, 1);
});

test("checkout never opens a URL returned after its account changed", async (t) => {
  const { state, usage } = await setup(t);
  state.checkout = async () => {
    state.generation++;
    return { success: true, url: "https://checkout.stripe.com/stale" };
  };
  await React.act(async () => assert.equal((await usage.openCheckout()).success, false));
  assert.deepEqual(state.opened, []);
});
