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
      setTimeout: (callback, delay) => ((h.expiry = { callback, delay }), 2),
      clearTimeout: () => {
        h.expiry = undefined;
      },
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
  const { useEnterpriseIdentityStore, refreshEnterpriseIdentityForUse, getManagedScopeResolution } =
    await vite.ssrLoadModule("/stores/enterpriseIdentityStore.ts");
  h.beforeUse = refreshEnterpriseIdentityForUse;
  h.resolve = getManagedScopeResolution;
  h.store = useEnterpriseIdentityStore;
  t.mock.method(Date, "now", () => h.now);
  h.policy.setState({ status: "unmanaged" });
  await useEnterpriseIdentityStore.getState().refresh("account-a", "workspace-a", 1);
  // Lets the answer to a request the timer or a listener started land.
  h.settle = () => new Promise((resolve) => setImmediate(resolve));
  return h;
}

test("an idle non-Enterprise workspace rechecks at the refusal expiry between periodic ticks", async (t) => {
  const h = await boot(t);
  h.tick();
  h.focus();
  h.now += RECHECK - 1;
  h.tick();
  assert.equal(h.requests, 1);

  assert.equal(h.expiry.delay, 1);
  h.now += 1;
  h.expiry.callback();
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

test("active use and focus share a five-minute recheck even while the idle timer can wait", async (t) => {
  const h = await boot(t);
  h.now += 5 * 60_000 - 1;
  h.focus();
  await h.beforeUse();
  assert.equal(h.requests, 1);

  h.now += 1;
  h.tick();
  assert.equal(h.requests, 1);
  const reply = Promise.withResolvers();
  h.answer = reply.promise;
  h.focus();
  const routing = h.beforeUse();
  assert.ok(routing);
  assert.equal(h.requests, 2);
  reply.resolve({
    ...enterprise,
    config: {
      ...enterprise.config,
      providers: [
        {
          provider: "bedrock",
          mode: "managed_required",
          allowManualSetup: false,
          version: 1,
          config: { scopeDefaults: { dictationCleanup: "managed-model" } },
        },
      ],
    },
  });
  await routing;
  assert.equal(h.resolve("dictationCleanup", "manual").kind, "managed");
});

test("a transient failure after a device-test link restores ordinary focus retries", async (t) => {
  const h = await boot(t);
  h.answer = refused("MANAGED_CONFIG_FAILED");
  h.link();
  await h.settle();
  h.answer = enterprise;
  h.focus();
  assert.equal(h.requests, 3);
});

test("a policy that recovers from an error into managed fetches providers immediately", async (t) => {
  const h = await boot(t);
  h.policy.setState({ status: "error" });
  h.policy.setState({ status: "managed" });
  assert.equal(h.requests, 2);
});

test("changing workspace while an active route checks its provider cancels that operation", async (t) => {
  const h = await boot(t);
  h.now += 5 * 60_000;
  const reply = Promise.withResolvers();
  h.answer = reply.promise;
  const routing = h.beforeUse();
  h.store.getState().clear();
  reply.resolve(enterprise);
  await assert.rejects(routing, { name: "AbortError" });
});
