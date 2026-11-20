const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const RECHECK = 15 * 60 * 1000;
const identity = { accountId: "account-a", workspaceId: "workspace-a", authGeneration: 1 };
const refused = (code) => ({
  ...identity,
  success: false,
  status: "error",
  code,
  error: "refused",
  enforcementRequired: false,
  enforcedScopes: [],
  enforcedAudioOperations: [],
});
// An Enterprise workspace whose administrator has set up no provider yet.
const enterprise = {
  ...identity,
  success: true,
  status: "network",
  config: { workspaceId: "workspace-a", version: 1, generation: 1, providers: [] },
};

// The store after its first answer for an account no policy manages, with its
// five-minute timer, focus listener and main's broadcasts in the test's hands.
async function boot(t, firstAnswer = refused("ENTERPRISE_REQUIRED")) {
  const h = { answer: firstAnswer, requests: 0, now: Date.parse("2026-11-19T12:00:00.000Z") };
  installBrowserGlobals(t, {
    window: {
      addEventListener: (type, listener) => type === "focus" && (h.focus = listener),
      setInterval: (callback) => ((h.tick = callback), 1),
      electronAPI: {
        onManagedEnterpriseConfigChanged: (callback) => ((h.notify = callback), () => {}),
        onEnterpriseAudioTestRequested: (callback) => ((h.link = callback), () => {}),
        getManagedEnterpriseConfig: async () => {
          h.requests += 1;
          return h.answer;
        },
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-identity-polling-" });
  h.policy = (await vite.ssrLoadModule("/stores/policyStore.ts")).usePolicyStore;
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  t.mock.method(Date, "now", () => h.now);
  h.policy.setState({ status: "unmanaged" });
  await useEnterpriseIdentityStore.getState().refresh("account-a", "workspace-a", 1);
  // Lets the answer to a request the timer or a listener started land.
  h.settle = () => new Promise((resolve) => setImmediate(resolve));
  return h;
}

test("a workspace the API calls non-Enterprise is asked every fifteen minutes, not every five or on focus", async (t) => {
  const h = await boot(t);
  h.tick();
  h.focus();
  h.now += RECHECK - 1;
  h.tick();
  assert.equal(h.requests, 1);

  h.now += 1;
  h.tick();
  assert.equal(h.requests, 2);
  await h.settle();
  h.tick();
  h.focus();
  assert.equal(h.requests, 2);
});

test("an account a policy starts managing asks at once and keeps the five-minute refresh", async (t) => {
  const h = await boot(t);
  h.tick();
  assert.equal(h.requests, 1);

  h.policy.setState({ status: "managed" });
  assert.equal(h.requests, 2);
  await h.settle();
  h.tick();
  assert.equal(h.requests, 3);
});

test("an administrator's device-test link asks at once", async (t) => {
  const h = await boot(t);
  h.tick();
  assert.equal(h.requests, 1);

  h.link();
  assert.equal(h.requests, 2);
});

test("an outage or an Enterprise workspace keeps the refresh; another window's answer ends it", async (t) => {
  const h = await boot(t, refused("MANAGED_CONFIG_FAILED"));
  h.tick();
  await h.settle();
  h.answer = enterprise;
  h.focus();
  await h.settle();
  h.tick();
  await h.settle();
  assert.equal(h.requests, 4);

  h.notify({ ...refused("ENTERPRISE_REQUIRED"), config: null });
  h.tick();
  h.focus();
  assert.equal(h.requests, 4);
});
