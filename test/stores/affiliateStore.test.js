const test = require("node:test");
const assert = require("node:assert/strict");
const { installBrowserGlobals, createRendererServer } = require("../lib/rendererTestHarness");

async function setup(t, { saved = false, consent = true } = {}) {
  let candidate = { link: "https://try.openwhispr.com/creator", clickId: null, saved: false };
  let generation = 7;
  const requests = [];
  let resolve = async () => ({ link: candidate.link, clickId: "click" });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        getAffiliateCandidate: async () => ({
          config: { domain: "try.openwhispr.com" },
          candidate,
          generation,
        }),
        saveAffiliateCandidate: async (input) => {
          candidate = input;
        },
        resolveAffiliateLink: async (...args) => resolve(...args),
      },
    },
  });
  global.__affiliateTest = {
    get generation() {
      return generation;
    },
    consent,
    requests,
    saved,
  };
  t.after(() => delete global.__affiliateTest);
  const vite = await createRendererServer(t, {
    cachePrefix: "affiliate-store-",
    mockModules: {
      "/lib/authRequestContext": `export const getValidatedAuthGeneration=()=>globalThis.__affiliateTest.generation; export const getAuthRequestContextSnapshot=()=>({observedGeneration:globalThis.__affiliateTest.generation}); export const subscribeAuthRequestContext=()=>()=>{};`,
      settingsStore: `export const useSettingsStore={getState:()=>({telemetryEnabled:globalThis.__affiliateTest.consent})};`,
      "/services/cloudApi": `export async function cloudGetForAuthGeneration(){return {data:{persisted:globalThis.__affiliateTest.saved,status:'registered'}};} export async function cloudPostForAuthGeneration(...args){globalThis.__affiliateTest.requests.push(args);return {data:{persisted:true,status:'pending'}};}`,
    },
  });
  const store = await vite.ssrLoadModule("/stores/affiliateStore.ts");
  return {
    ...store,
    requests,
    candidate: () => candidate,
    switchAccount: () => {
      generation++;
    },
    setResolve: (fn) => {
      resolve = fn;
    },
  };
}
test("first saved account referral wins over a new local candidate", async (t) => {
  const s = await setup(t, { saved: true });
  assert.equal(await s.prepareAffiliateCheckout(), true);
  assert.equal(s.useAffiliateStore.getState().saved, true);
  assert.equal(s.requests.length, 0);
});
test("disabled tracking never resolves or claims a creator link", async (t) => {
  const s = await setup(t, { consent: false });
  s.setResolve(() => assert.fail("must not resolve"));
  assert.equal(await s.prepareAffiliateCheckout(), false);
  assert.equal(s.requests.length, 0);
  assert.equal(s.useAffiliateStore.getState().error, "privacy");
});
test("claim uses the captured auth generation and saves only acknowledged state", async (t) => {
  const s = await setup(t);
  assert.equal(await s.prepareAffiliateCheckout(), true);
  assert.deepEqual(
    s.requests.map((r) => [r[0], r[2]]),
    [
      ["/api/affiliate/check-link", 7],
      ["/api/affiliate/claim", 7],
    ]
  );
  assert.equal(s.requests[1][1].clickId, "click");
  assert.equal(s.candidate().saved, true);
});
test("account switch during link resolution prevents claim and persistence", async (t) => {
  const s = await setup(t);
  s.setResolve(async () => {
    s.switchAccount();
    return { link: s.candidate().link, clickId: "click" };
  });
  assert.equal(await s.prepareAffiliateCheckout(), false);
  assert.equal(s.requests.length, 1);
  assert.equal(s.candidate().saved, false);
});
test("parallel checkout attempts share one claim operation", async (t) => {
  const s = await setup(t);
  assert.deepEqual(
    await Promise.all([s.prepareAffiliateCheckout(), s.prepareAffiliateCheckout()]),
    [true, true]
  );
  assert.equal(s.requests.filter((r) => r[0] === "/api/affiliate/claim").length, 1);
});
