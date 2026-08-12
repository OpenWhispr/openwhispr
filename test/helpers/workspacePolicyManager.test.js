const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createWorkspacePolicyManager } = require("../../src/helpers/workspacePolicyManager");

const validPolicy = (updatedAt = "2026-08-05T00:00:00.000Z") => ({
  data: {
    managed: true,
    policy: {
      version: 1,
      transcription: { allowedModes: ["local"], allowedByokProviders: [] },
      llm: { allowedModes: ["local"], allowedByokProviders: [], allowedEnterpriseProviders: [] },
      features: { agentEnabled: false, webSearchEnabled: false },
      sharing: { externalLinkSharing: "disabled" },
      dataRetention: {
        audioRetentionMaxDays: 30,
        localHistoryMode: "always_off",
        cloudBackupAllowed: false,
      },
      minAppVersion: "1.8.1",
    },
    policyUpdatedAt: updatedAt,
  },
});

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setup(proxyFetch, overrides = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-policy-manager-"));
  const cachePath = path.join(tempDir, "workspace-policy.json");
  const tokenState = { token: "token-a", generation: 1 };
  const broadcasts = [];
  const manager = createWorkspacePolicyManager({
    cachePath,
    getApiUrl: () => "https://api.openwhispr.test",
    getAppVersion: () => "1.8.1",
    proxyFetch,
    tokenStore: { getState: () => ({ ...tokenState }) },
    broadcast: (snapshot) => broadcasts.push(snapshot),
    logger: { error() {}, warn() {} },
    requestTimeoutMs: 20,
    successfulRefreshMs: 0,
    minimumAttemptIntervalMs: 0,
    ...overrides,
  });
  return {
    manager,
    cachePath,
    tokenState,
    broadcasts,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

test("caches authoritative unmanaged verdicts for offline startup", async (t) => {
  let online = true;
  const context = setup(async (_url, init) => {
    assert.equal(init.headers["x-openwhispr-policy-version"], "1");
    assert.equal(init.headers["x-openwhispr-version"], "1.8.1");
    if (!online) throw new Error("offline");
    return response(200, { data: { managed: false, policy: null, policyUpdatedAt: null } });
  });
  t.after(context.cleanup);

  const first = await context.manager.getPolicy({
    accountId: "account-a",
    expectedAuthGeneration: 1,
  });
  online = false;
  const second = await context.manager.getPolicy({
    accountId: "account-a",
    expectedAuthGeneration: 1,
  });

  assert.equal(first.managed, false);
  assert.equal(second.success, true);
  assert.equal(second.status, "cached");
  assert.equal(second.managed, false);
});

test("renderer account labels do not override credential-bound cache identity", async (t) => {
  let online = true;
  const context = setup(async () => {
    if (!online) throw new Error("offline");
    return response(200, { data: { managed: false, policy: null, policyUpdatedAt: null } });
  });
  t.after(context.cleanup);

  await context.manager.getPolicy({ accountId: "renderer-label-a", expectedAuthGeneration: 1 });
  online = false;
  const cached = await context.manager.getPolicy({
    accountId: "renderer-label-b",
    expectedAuthGeneration: 1,
  });

  assert.equal(cached.success, true);
  assert.equal(cached.status, "cached");
  assert.equal(cached.accountId, "renderer-label-b");
});

test("legacy cookie-authenticated callers cache unmanaged policy by the credential used", async (t) => {
  let online = true;
  const context = setup(async (_url, init) => {
    assert.equal(init.headers.Cookie, "session=legacy-account");
    assert.equal(init.headers.Authorization, undefined);
    if (!online) throw new Error("offline");
    return response(200, { data: { managed: false, policy: null, policyUpdatedAt: null } });
  });
  t.after(context.cleanup);
  context.tokenState.token = null;

  const request = {
    accountId: "legacy-account",
    expectedAuthGeneration: 1,
    authHeaders: { Cookie: "session=legacy-account" },
  };
  const first = await context.manager.getPolicy(request);
  online = false;
  const cached = await context.manager.getPolicy(request);

  assert.equal(first.managed, false);
  assert.equal(cached.success, true);
  assert.equal(cached.status, "cached");
});

test("accepts and caches the API's legacy-compatible unmanaged default-policy envelope", async (t) => {
  const defaultPolicy = {
    version: 1,
    transcription: {
      allowedModes: ["openwhispr", "providers", "local", "self-hosted"],
      allowedByokProviders: ["openai", "groq", "xai", "mistral", "corti", "tinfoil"],
    },
    llm: {
      allowedModes: ["openwhispr", "providers", "local", "self-hosted", "enterprise"],
      allowedByokProviders: ["openai", "anthropic", "gemini", "groq", "tinfoil", "corti"],
      allowedEnterpriseProviders: ["bedrock", "azure", "vertex"],
    },
    features: { agentEnabled: true, webSearchEnabled: true },
    sharing: { externalLinkSharing: "allowed" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: true,
    },
    minAppVersion: null,
  };
  let online = true;
  const context = setup(async () => {
    if (!online) throw new Error("offline");
    return response(200, {
      data: { managed: false, policy: defaultPolicy, policyUpdatedAt: null },
    });
  });
  t.after(context.cleanup);

  const first = await context.manager.getPolicy({
    accountId: "account-a",
    expectedAuthGeneration: 1,
  });
  online = false;
  const cached = await context.manager.getPolicy({
    accountId: "account-a",
    expectedAuthGeneration: 1,
  });

  assert.equal(first.success, true);
  assert.equal(first.managed, false);
  assert.deepEqual(first.policy, defaultPolicy);
  assert.equal(cached.status, "cached");
  assert.equal(cached.managed, false);
  assert.deepEqual(cached.policy, defaultPolicy);
});

test("treats 404 and 501 policy endpoints as authoritative legacy unmanaged servers", async (t) => {
  for (const status of [404, 501]) {
    const context = setup(async () => response(status, { error: "unsupported" }));
    t.after(context.cleanup);
    const result = await context.manager.getPolicy({
      accountId: `account-${status}`,
      expectedAuthGeneration: 1,
    });
    assert.equal(result.success, true, String(status));
    assert.equal(result.managed, false, String(status));
    assert.equal(result.endpointSupported, false, String(status));
  }
});

test("a 404 cannot replace an in-memory managed last-good policy", async (t) => {
  const responses = [response(200, validPolicy()), response(404, { error: "not found" })];
  const context = setup(async () => responses.shift());
  t.after(context.cleanup);

  const managed = await context.manager.getPolicy({
    accountId: "account-a",
    expectedAuthGeneration: 1,
  });
  const fallback = await context.manager.getPolicy({
    accountId: "account-a",
    expectedAuthGeneration: 1,
  });

  assert.equal(fallback.status, "cached");
  assert.equal(fallback.managed, true);
  assert.deepEqual(fallback.policy, managed.policy);
  assert.equal(fallback.policyUpdatedAt, managed.policyUpdatedAt);
  assert.equal(context.broadcasts.length, 1);
});

test("a 501 after restart cannot replace a disk-cached managed last-good policy", async (t) => {
  const context = setup(async () => response(200, validPolicy()));
  t.after(context.cleanup);
  const request = { accountId: "account-a", expectedAuthGeneration: 1 };
  await context.manager.getPolicy(request);

  const restarted = createWorkspacePolicyManager({
    cachePath: context.cachePath,
    getApiUrl: () => "https://api.openwhispr.test",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => response(501, { error: "not implemented" }),
    tokenStore: { getState: () => ({ ...context.tokenState }) },
    logger: { error() {}, warn() {} },
  });
  const fallback = await restarted.getPolicy(request);

  const offlineRestart = createWorkspacePolicyManager({
    cachePath: context.cachePath,
    getApiUrl: () => "https://api.openwhispr.test",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => {
      throw new Error("offline");
    },
    tokenStore: { getState: () => ({ ...context.tokenState }) },
    logger: { error() {}, warn() {} },
  });
  const cached = await offlineRestart.getPolicy(request);

  assert.equal(fallback.status, "cached");
  assert.equal(fallback.managed, true);
  assert.equal(cached.managed, true);
  assert.deepEqual(cached.policy, fallback.policy);
  assert.equal(cached.policyUpdatedAt, fallback.policyUpdatedAt);
});

test("reuses a successful managed policy for five minutes, then accepts an update", async (t) => {
  let currentTime = 0;
  let requestCount = 0;
  const initial = validPolicy("2026-08-05T00:00:00.000Z");
  const updated = validPolicy("2026-08-05T00:05:00.000Z");
  updated.data.policy.features.agentEnabled = true;
  const responses = [response(200, initial), response(200, updated)];
  const context = setup(
    async () => {
      requestCount += 1;
      return responses.shift();
    },
    { now: () => currentTime, successfulRefreshMs: 300_000 }
  );
  t.after(context.cleanup);
  const request = { accountId: "account-a", expectedAuthGeneration: 1 };

  const first = await context.manager.getPolicy(request);
  currentTime = 299_999;
  const fresh = await context.manager.getPolicy(request);
  currentTime = 300_000;
  const refreshed = await context.manager.getPolicy(request);

  assert.equal(first.policy.features.agentEnabled, false);
  assert.equal(fresh.policy.features.agentEnabled, false);
  assert.equal(refreshed.policy.features.agentEnabled, true);
  assert.equal(requestCount, 2);
  assert.equal(context.broadcasts.length, 2);
});

test("refreshes a managed identity to authoritative unmanaged after five minutes", async (t) => {
  let currentTime = 0;
  let requestCount = 0;
  const responses = [
    response(200, validPolicy()),
    response(200, { data: { managed: false, policy: null, policyUpdatedAt: null } }),
  ];
  const context = setup(
    async () => {
      requestCount += 1;
      return responses.shift();
    },
    { now: () => currentTime, successfulRefreshMs: 300_000 }
  );
  t.after(context.cleanup);
  const request = { accountId: "account-a", expectedAuthGeneration: 1 };

  assert.equal((await context.manager.getPolicy(request)).managed, true);
  currentTime = 299_999;
  assert.equal((await context.manager.getPolicy(request)).managed, true);
  currentTime = 300_000;
  assert.equal((await context.manager.getPolicy(request)).managed, false);
  assert.equal(requestCount, 2);
  assert.equal(context.broadcasts.length, 2);
});

test("cached errors do not extend successful policy freshness", async (t) => {
  let currentTime = 0;
  let requestCount = 0;
  const updated = validPolicy("2026-08-05T00:05:00.000Z");
  updated.data.policy.features.agentEnabled = true;
  const context = setup(
    async () => {
      requestCount += 1;
      if (requestCount === 1) return response(200, validPolicy());
      if (requestCount === 2) throw new Error("offline");
      return response(200, updated);
    },
    { now: () => currentTime, successfulRefreshMs: 300_000 }
  );
  t.after(context.cleanup);
  const request = { accountId: "account-a", expectedAuthGeneration: 1 };

  await context.manager.getPolicy(request);
  currentTime = 300_000;
  assert.equal((await context.manager.getPolicy(request)).status, "cached");
  currentTime = 300_001;
  const recovered = await context.manager.getPolicy(request);

  assert.equal(recovered.policy.features.agentEnabled, true);
  assert.equal(requestCount, 3);
});

test("known-managed unsupported fallbacks do not extend successful freshness", async (t) => {
  let currentTime = 0;
  let requestCount = 0;
  const updated = validPolicy("2026-08-05T00:05:00.000Z");
  updated.data.policy.features.agentEnabled = true;
  const context = setup(
    async () => {
      requestCount += 1;
      if (requestCount === 1) return response(200, validPolicy());
      if (requestCount === 2) return response(404, { error: "not found" });
      return response(200, updated);
    },
    { now: () => currentTime, successfulRefreshMs: 300_000 }
  );
  t.after(context.cleanup);
  const request = { accountId: "account-a", expectedAuthGeneration: 1 };

  await context.manager.getPolicy(request);
  currentTime = 300_000;
  const fallback = await context.manager.getPolicy(request);
  currentTime = 300_001;
  const recovered = await context.manager.getPolicy(request);

  assert.equal(fallback.status, "cached");
  assert.equal(fallback.managed, true);
  assert.equal(recovered.policy.features.agentEnabled, true);
  assert.equal(requestCount, 3);
});

test("throttles sequential focus refreshes after a fallback", async (t) => {
  let currentTime = 0;
  let requestCount = 0;
  const updated = validPolicy("2026-08-05T00:05:00.000Z");
  updated.data.policy.features.agentEnabled = true;
  const context = setup(
    async () => {
      requestCount += 1;
      if (requestCount === 1) return response(200, validPolicy());
      if (requestCount <= 2) throw new Error("offline");
      return response(200, updated);
    },
    {
      now: () => currentTime,
      successfulRefreshMs: 300_000,
      minimumAttemptIntervalMs: 5_000,
    }
  );
  t.after(context.cleanup);
  const request = { accountId: "account-a", expectedAuthGeneration: 1 };

  await context.manager.getPolicy(request);
  currentTime = 300_000;
  assert.equal((await context.manager.getPolicy(request)).status, "cached");
  currentTime = 300_001;
  assert.equal((await context.manager.getPolicy(request)).status, "cached");
  assert.equal(requestCount, 2);

  currentTime = 305_002;
  const recovered = await context.manager.getPolicy(request);
  assert.equal(recovered.policy.features.agentEnabled, true);
  assert.equal(requestCount, 3);
});

test("a stale managed HTTP response cannot replace a newer disk policy after restart", async (t) => {
  const context = setup(async () => response(200, validPolicy("2026-08-05T00:10:00.000Z")));
  t.after(context.cleanup);
  const request = { accountId: "account-a", expectedAuthGeneration: 1 };
  const newer = await context.manager.getPolicy(request);

  const restartedBroadcasts = [];
  const restarted = createWorkspacePolicyManager({
    cachePath: context.cachePath,
    getApiUrl: () => "https://api.openwhispr.test",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => response(200, validPolicy("2026-08-05T00:05:00.000Z")),
    tokenStore: { getState: () => ({ ...context.tokenState }) },
    broadcast: (snapshot) => restartedBroadcasts.push(snapshot),
    logger: { error() {}, warn() {} },
  });
  const result = await restarted.getPolicy(request);

  assert.equal(result.managed, true);
  assert.equal(result.policyUpdatedAt, newer.policyUpdatedAt);
  assert.equal(result.status, "current");
  assert.equal(restartedBroadcasts.length, 0);
});

test("times out a policy request and returns a matching cache when available", async (t) => {
  let hang = false;
  const context = setup(async (_url, init) => {
    if (!hang)
      return response(200, { data: { managed: false, policy: null, policyUpdatedAt: null } });
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  });
  t.after(context.cleanup);
  await context.manager.getPolicy({ accountId: "account-a", expectedAuthGeneration: 1 });
  hang = true;

  const result = await context.manager.getPolicy({
    accountId: "account-a",
    expectedAuthGeneration: 1,
  });
  assert.equal(result.success, true);
  assert.equal(result.status, "cached");
});

test("a delayed account A response cannot mutate state after credentials switch to B", async (t) => {
  let resolveRequest;
  const context = setup(() => new Promise((resolve) => (resolveRequest = resolve)), {
    requestTimeoutMs: 1000,
  });
  t.after(context.cleanup);

  const pending = context.manager.getPolicy({ accountId: "account-a", expectedAuthGeneration: 1 });
  context.tokenState.token = "token-b";
  context.tokenState.generation = 2;
  resolveRequest(response(200, validPolicy()));
  const result = await pending;

  assert.equal(result.success, false);
  assert.equal(result.code, "AUTH_CONTEXT_CHANGED");
  assert.equal(context.broadcasts.length, 0);
});

test("deduplicates concurrent window requests and broadcasts one authoritative snapshot", async (t) => {
  let calls = 0;
  let resolveRequest;
  const context = setup(() => {
    calls += 1;
    return new Promise((resolve) => (resolveRequest = resolve));
  });
  t.after(context.cleanup);

  const first = context.manager.getPolicy({ accountId: "account-a", expectedAuthGeneration: 1 });
  const second = context.manager.getPolicy({ accountId: "account-a", expectedAuthGeneration: 1 });
  resolveRequest(response(200, validPolicy()));
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(firstResult.revision, secondResult.revision);
  assert.equal(context.broadcasts.length, 1);
});

test("rejects an older policy response instead of downgrading main or cache state", async (t) => {
  const responses = [
    response(200, validPolicy("2026-08-05T02:00:00.000Z")),
    response(200, validPolicy("2026-08-05T01:00:00.000Z")),
  ];
  const context = setup(async () => responses.shift());
  t.after(context.cleanup);

  const newest = await context.manager.getPolicy({
    accountId: "account-a",
    expectedAuthGeneration: 1,
  });
  const stale = await context.manager.getPolicy({
    accountId: "account-a",
    expectedAuthGeneration: 1,
  });

  assert.equal(stale.policyUpdatedAt, newest.policyUpdatedAt);
  assert.equal(stale.revision, newest.revision);
  assert.equal(context.broadcasts.length, 1);
});

test("invalid managed policy fails closed and broadcasts only the error state", async (t) => {
  const malformed = validPolicy();
  malformed.data.policy.version = 2;
  const context = setup(async () => response(200, malformed));
  t.after(context.cleanup);

  const result = await context.manager.getPolicy({
    accountId: "account-a",
    expectedAuthGeneration: 1,
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "POLICY_UNRESOLVABLE");
  assert.equal(context.broadcasts.length, 1);
  assert.equal(context.broadcasts[0].success, false);
  assert.equal(context.broadcasts[0].code, "POLICY_UNRESOLVABLE");
});

test("a first policy-enabled offline launch remains unavailable without a policy verdict", async (t) => {
  const context = setup(async () => {
    throw new Error("offline");
  });
  t.after(context.cleanup);

  const result = await context.manager.getPolicy({
    accountId: "account-a",
    expectedAuthGeneration: 1,
  });

  assert.equal(result.success, false);
  assert.equal(result.status, "error");
  assert.equal(result.code, "POLICY_UNAVAILABLE");
  assert.equal(context.broadcasts.length, 0);
});

test("HTTP policy denials and malformed success payloads remain unavailable", async (t) => {
  for (const proxyFetch of [
    async () => response(403, { error: "managed policy denied", code: "POLICY_DENIED" }),
    async () => response(200, { data: { managed: true, policy: null } }),
  ]) {
    const context = setup(proxyFetch);
    t.after(context.cleanup);
    const result = await context.manager.getPolicy({
      accountId: "account-a",
      expectedAuthGeneration: 1,
    });
    assert.equal(result.success, false);
    assert.equal(result.status, "error");
  }
});

test("a positive managed-unresolvable signal cannot reuse an unmanaged cache", async (t) => {
  for (const failedResponse of [
    response(503, {
      error: "Organization policy could not be resolved.",
      code: "POLICY_UNRESOLVABLE",
    }),
    response(200, { data: { managed: true, policy: null, policyUpdatedAt: null } }),
  ]) {
    const responses = [
      response(200, { data: { managed: false, policy: null, policyUpdatedAt: null } }),
      failedResponse,
    ];
    const context = setup(async () => responses.shift());
    t.after(context.cleanup);
    const request = { accountId: "account-a", expectedAuthGeneration: 1 };

    const unmanaged = await context.manager.getPolicy(request);
    const transitioned = await context.manager.getPolicy(request);

    assert.equal(unmanaged.success, true);
    assert.equal(unmanaged.managed, false);
    assert.equal(transitioned.success, false);
    assert.equal(transitioned.status, "error");
    assert.equal(transitioned.code, "POLICY_UNRESOLVABLE");
  }
});

test("a managed cache remains fail-closed during an unresolvable refresh", async (t) => {
  const responses = [
    response(200, validPolicy()),
    response(503, {
      error: "Organization policy could not be resolved.",
      code: "POLICY_UNRESOLVABLE",
    }),
  ];
  const context = setup(async () => responses.shift());
  t.after(context.cleanup);
  const request = { accountId: "account-a", expectedAuthGeneration: 1 };

  const managed = await context.manager.getPolicy(request);
  const fallback = await context.manager.getPolicy(request);

  assert.equal(fallback.success, true);
  assert.equal(fallback.status, "cached");
  assert.equal(fallback.managed, true);
  assert.deepEqual(fallback.policy, managed.policy);
});

test("a first-ever unresolvable verdict still fails closed after restart", async (t) => {
  const context = setup(async () =>
    response(503, {
      error: "Organization policy could not be resolved.",
      code: "POLICY_UNRESOLVABLE",
    })
  );
  t.after(context.cleanup);
  const request = { accountId: "account-a", expectedAuthGeneration: 1 };

  const unresolvable = await context.manager.getPolicy(request);
  assert.equal(unresolvable.success, false);
  assert.equal(unresolvable.code, "POLICY_UNRESOLVABLE");

  // Nothing was ever cached for this identity, so the marker is the only thing
  // on disk standing between a restart and a fail-open on an unsupported route.
  const restarted = createWorkspacePolicyManager({
    cachePath: context.cachePath,
    getApiUrl: () => "https://api.openwhispr.test",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => response(404, { error: "Not found" }),
    tokenStore: { getState: () => ({ ...context.tokenState }) },
    logger: { error() {}, warn() {} },
  });
  const afterRestart = await restarted.getPolicy(request);

  assert.equal(afterRestart.success, false);
  assert.equal(afterRestart.code, "POLICY_UNRESOLVABLE");
});

test("a managed-unresolvable signal survives throttling, other windows, and restart", async (t) => {
  let currentTime = 0;
  let requestCount = 0;
  const context = setup(
    async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return response(200, { data: { managed: false, policy: null, policyUpdatedAt: null } });
      }
      return response(503, {
        error: "Organization policy could not be resolved.",
        code: "POLICY_UNRESOLVABLE",
      });
    },
    {
      now: () => currentTime,
      successfulRefreshMs: 0,
      minimumAttemptIntervalMs: 5_000,
    }
  );
  t.after(context.cleanup);
  const request = { accountId: "account-a", expectedAuthGeneration: 1 };

  assert.equal((await context.manager.getPolicy(request)).managed, false);
  currentTime = 5_000;
  const unresolvable = await context.manager.getPolicy(request);
  const throttledOtherWindow = await context.manager.getPolicy(request);

  assert.equal(unresolvable.success, false);
  assert.equal(unresolvable.code, "POLICY_UNRESOLVABLE");
  assert.equal(throttledOtherWindow.success, false);
  assert.equal(throttledOtherWindow.code, "POLICY_UNRESOLVABLE");
  assert.equal(requestCount, 2);
  assert.equal(context.broadcasts.at(-1).success, false);
  assert.equal(context.broadcasts.at(-1).code, "POLICY_UNRESOLVABLE");

  const restarted = createWorkspacePolicyManager({
    cachePath: context.cachePath,
    getApiUrl: () => "https://api.openwhispr.test",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => {
      throw new Error("offline");
    },
    tokenStore: { getState: () => ({ ...context.tokenState }) },
    logger: { error() {}, warn() {} },
  });
  const offlineRestart = await restarted.getPolicy(request);

  assert.equal(offlineRestart.success, false);
  assert.equal(offlineRestart.code, "POLICY_UNRESOLVABLE");
});

test("a corrupt policy cache cannot authorize an offline identity", async (t) => {
  const context = setup(async () => {
    throw new Error("offline");
  });
  t.after(context.cleanup);
  fs.writeFileSync(context.cachePath, "{not valid json", "utf8");

  const result = await context.manager.getPolicy({
    accountId: "account-a",
    expectedAuthGeneration: 1,
  });

  assert.equal(result.success, false);
  assert.equal(result.code, "POLICY_UNAVAILABLE");
  assert.equal(context.broadcasts.length, 0);
});

test("an unmanaged verdict cannot be rebound to a new credential or API origin", async (t) => {
  let online = true;
  const context = setup(async () => {
    if (!online) throw new Error("offline");
    return response(200, { data: { managed: false, policy: null, policyUpdatedAt: null } });
  });
  t.after(context.cleanup);
  const originalRequest = { accountId: "account-a", expectedAuthGeneration: 1 };

  const original = await context.manager.getPolicy(originalRequest);
  assert.equal(original.managed, false);
  online = false;
  context.tokenState.token = "token-b";
  context.tokenState.generation = 2;
  const newCredential = await context.manager.getPolicy({
    accountId: "account-a",
    expectedAuthGeneration: 2,
  });

  assert.equal(newCredential.success, false);
  assert.equal(newCredential.code, "POLICY_UNAVAILABLE");

  context.tokenState.token = "token-a";
  context.tokenState.generation = 1;
  const differentOrigin = createWorkspacePolicyManager({
    cachePath: context.cachePath,
    getApiUrl: () => "https://self-host.openwhispr.test",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => {
      throw new Error("offline");
    },
    tokenStore: { getState: () => ({ ...context.tokenState }) },
    logger: { error() {}, warn() {} },
    requestTimeoutMs: 20,
    successfulRefreshMs: 0,
    minimumAttemptIntervalMs: 0,
  });
  const reboundOrigin = await differentOrigin.getPolicy(originalRequest);

  assert.equal(reboundOrigin.success, false);
  assert.equal(reboundOrigin.code, "POLICY_UNAVAILABLE");
});

test("serves the in-memory verdict when the disk cache is unreadable during an outage", async (t) => {
  let online = true;
  const context = setup(async () => {
    if (!online) throw new Error("offline");
    return response(200, { data: validPolicy().data });
  });
  t.after(context.cleanup);
  const request = { accountId: "account-a", expectedAuthGeneration: 1 };

  const first = await context.manager.getPolicy(request);
  assert.equal(first.status, "network");

  fs.writeFileSync(context.cachePath, "not json");
  online = false;
  const fallback = await context.manager.getPolicy(request);
  assert.equal(fallback.success, true);
  assert.equal(fallback.status, "cached");
  assert.equal(fallback.managed, true);
});

test("a stale-but-successful refresh still counts toward the refresh TTL", async (t) => {
  let currentTime = 0;
  let fetches = 0;
  const context = setup(
    async () => {
      fetches += 1;
      return response(200, {
        data: validPolicy(fetches === 1 ? "2026-08-05T00:00:00.000Z" : "2026-08-01T00:00:00.000Z")
          .data,
      });
    },
    { successfulRefreshMs: 5 * 60 * 1000, now: () => currentTime }
  );
  t.after(context.cleanup);
  const request = { accountId: "account-a", expectedAuthGeneration: 1 };

  await context.manager.getPolicy(request);
  currentTime += 6 * 60 * 1000;
  const stale = await context.manager.getPolicy(request);
  assert.equal(stale.status, "current");
  assert.equal(fetches, 2);

  currentTime += 60 * 1000;
  const held = await context.manager.getPolicy(request);
  assert.equal(held.status, "current");
  assert.equal(fetches, 2, "a lagging server must not defeat the refresh TTL");
});

test("a policy request without a validated auth generation fails closed", async (t) => {
  const context = setup(async () => response(200, { data: validPolicy().data }));
  t.after(context.cleanup);

  const result = await context.manager.getPolicy({ accountId: "account-a" });
  assert.equal(result.success, false);
  assert.equal(result.code, "AUTH_CONTEXT_UNVALIDATED");
  assert.equal(result.accountId, "account-a");
  assert.equal(result.authGeneration, 1);
});

test("throttled errors carry the snapshot identity fields", async (t) => {
  const context = setup(
    async () => {
      throw new Error("offline");
    },
    { minimumAttemptIntervalMs: 60_000, now: () => 1_000_000 }
  );
  t.after(context.cleanup);
  const request = { accountId: "account-a", expectedAuthGeneration: 1 };

  await context.manager.getPolicy(request);
  const throttled = await context.manager.getPolicy(request);
  assert.equal(throttled.code, "POLICY_RETRY_THROTTLED");
  assert.equal(throttled.accountId, "account-a");
  assert.equal(throttled.authGeneration, 1);
});
