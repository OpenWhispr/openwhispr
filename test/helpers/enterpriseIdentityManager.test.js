const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createEnterpriseIdentityManager,
} = require("../../src/helpers/enterpriseIdentityManager.js");

const workspaceId = "11111111-1111-4111-8111-111111111111";
const accountId = "account-a";

function managedConfig() {
  const defaults = {
    dictationCleanup: "deployment-a",
    dictationAgent: "deployment-a",
    noteFormatting: "deployment-a",
    chatIntelligence: "deployment-a",
    dictationTranslation: "deployment-a",
  };
  return {
    workspaceId,
    version: 1,
    generation: 1,
    identity: {
      issuer: "https://api.example.com/enterprise-identity",
      jwksUri: "https://api.example.com/enterprise-identity/jwks.json",
      subject: `workspace:${workspaceId}`,
      audiences: { bedrock: "sts.amazonaws.com", azure: "api://AzureADTokenExchange" },
    },
    providers: [
      {
        provider: "azure",
        mode: "managed_default",
        allowManualSetup: true,
        config: {
          tenantId: "22222222-2222-4222-8222-222222222222",
          clientId: "33333333-3333-4333-8333-333333333333",
          endpoint: "https://example.openai.azure.com",
          apiVersion: "v1",
          allowedDeployments: ["deployment-a"],
          scopeDefaults: defaults,
        },
        version: 1,
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
    ],
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function request(overrides = {}) {
  return {
    accountId,
    workspaceId,
    expectedAuthGeneration: 4,
    authHeaders: { Authorization: "Bearer openwhispr-session" },
    inferenceScope: "dictationCleanup",
    setupMode: "auto",
    ...overrides,
  };
}

test("deduplicates config and Azure token refreshes while keeping cloud tokens out of config", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const calls = { config: 0, assertion: 0, azure: 0 };
  const proxyFetch = async (url) => {
    if (url.includes("/enterprise-providers/azure/assertion")) {
      calls.assertion += 1;
      return jsonResponse({ data: { assertion: "signed-openwhispr-assertion" } });
    }
    if (url.startsWith("https://login.microsoftonline.com/")) {
      calls.azure += 1;
      return jsonResponse({ access_token: "azure-bearer-token", expires_in: 3600 });
    }
    calls.config += 1;
    return jsonResponse({ data: managedConfig() });
  };
  const tokenState = { token: "openwhispr-session", generation: 4 };
  const manager = createEnterpriseIdentityManager({
    cachePath: path.join(tempDir, "config.json"),
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch,
    tokenStore: { getState: () => tokenState },
  });

  const [left, right] = await Promise.all([
    manager.getConfig(request()),
    manager.getConfig(request()),
  ]);
  assert.equal(left.success, true);
  assert.equal(right.success, true);
  assert.equal(calls.config, 1);
  assert.equal(JSON.stringify(left).includes("azure-bearer-token"), false);
  assert.equal(JSON.stringify(left).includes("signed-openwhispr-assertion"), false);

  const runtime = await manager.resolveProvider(request());
  assert.equal(runtime.managed, true);
  assert.equal(runtime.provider, "azure");
  assert.equal(runtime.model, "deployment-a");
  assert.equal(await runtime.tokenProvider(), "azure-bearer-token");
  assert.equal(await runtime.tokenProvider(), "azure-bearer-token");
  assert.deepEqual(calls, { config: 1, assertion: 1, azure: 1 });
});

test("authorization failures evict cached config while server failures use it transiently", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const cachePath = path.join(tempDir, "config.json");
  const enforcedConfig = managedConfig();
  enforcedConfig.providers[0].mode = "managed_required";
  enforcedConfig.providers[0].allowManualSetup = false;
  let response = jsonResponse({ data: enforcedConfig });
  const manager = createEnterpriseIdentityManager({
    cachePath,
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => response.clone(),
    tokenStore: { getState: () => ({ token: "session", generation: 4 }) },
  });

  assert.equal((await manager.getConfig(request())).status, "network");
  response = jsonResponse({ error: "Temporarily unavailable" }, 503);
  assert.equal((await manager.getConfig({ ...request(), forceRefresh: true })).status, "cached");

  response = jsonResponse({ error: "Sign in with company SSO", code: "SSO_REQUIRED" }, 403);
  const denied = await manager.getConfig({ ...request(), forceRefresh: true });
  assert.equal(denied.success, false);
  assert.equal(denied.code, "SSO_REQUIRED");
  assert.equal(denied.enforcementRequired, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, "utf8")).entries, []);

  const repeatedDenial = await manager.getConfig({ ...request(), forceRefresh: true });
  assert.equal(repeatedDenial.code, "SSO_REQUIRED");
  assert.equal(repeatedDenial.enforcementRequired, true);
});

test("an Enterprise-plan downgrade clears prior managed enforcement", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const enforcedConfig = managedConfig();
  enforcedConfig.providers[0].mode = "managed_required";
  enforcedConfig.providers[0].allowManualSetup = false;
  let response = jsonResponse({ data: enforcedConfig });
  const snapshots = [];
  const manager = createEnterpriseIdentityManager({
    cachePath: path.join(tempDir, "config.json"),
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => response.clone(),
    tokenStore: { getState: () => ({ token: "session", generation: 4 }) },
    broadcast: (snapshot) => snapshots.push(snapshot),
  });

  assert.equal((await manager.getConfig(request())).success, true);
  response = jsonResponse(
    { error: "An active Enterprise workspace is required", code: "ENTERPRISE_REQUIRED" },
    403
  );
  const downgraded = await manager.getConfig({ ...request(), forceRefresh: true });
  assert.equal(downgraded.success, false);
  assert.equal(downgraded.code, "ENTERPRISE_REQUIRED");
  assert.equal(downgraded.enforcementRequired, false);
  assert.equal(snapshots.at(-1).enforcementRequired, false);
});

test("an authoritative unmanaged verdict survives restart and a transient outage", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const cachePath = path.join(tempDir, "config.json");
  const tokenStore = { getState: () => ({ token: "session", generation: 4 }) };
  const common = {
    cachePath,
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    tokenStore,
  };
  const online = createEnterpriseIdentityManager({
    ...common,
    proxyFetch: async () =>
      jsonResponse(
        { error: "An active Enterprise workspace is required", code: "ENTERPRISE_REQUIRED" },
        403
      ),
  });

  const unmanaged = await online.getConfig(request());
  assert.equal(unmanaged.enforcementRequired, false);

  const offline = createEnterpriseIdentityManager({
    ...common,
    proxyFetch: async () => {
      throw new Error("offline");
    },
  });
  const restored = await offline.getConfig(request());

  assert.equal(restored.success, false);
  assert.equal(restored.code, "ENTERPRISE_REQUIRED");
  assert.equal(restored.enforcementRequired, false);
});

test("an authoritative unmanaged verdict survives an unwritable cache in memory", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let offline = false;
  const manager = createEnterpriseIdentityManager({
    cachePath: tempDir,
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => {
      if (offline) throw new Error("offline");
      return jsonResponse(
        { error: "An active Enterprise workspace is required", code: "ENTERPRISE_REQUIRED" },
        403
      );
    },
    tokenStore: { getState: () => ({ token: "session", generation: 4 }) },
  });

  assert.equal((await manager.getConfig(request())).enforcementRequired, false);
  offline = true;
  const restored = await manager.getConfig({ ...request(), forceRefresh: true });

  assert.equal(restored.code, "ENTERPRISE_REQUIRED");
  assert.equal(restored.enforcementRequired, false);
});

test("a malformed successful config response fails closed instead of using disk cache", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const enforcedConfig = managedConfig();
  enforcedConfig.providers[0].mode = "managed_required";
  enforcedConfig.providers[0].allowManualSetup = false;
  let response = jsonResponse({ data: enforcedConfig });
  const cachePath = path.join(tempDir, "config.json");
  const manager = createEnterpriseIdentityManager({
    cachePath,
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => response.clone(),
    tokenStore: { getState: () => ({ token: "session", generation: 4 }) },
  });

  assert.equal((await manager.getConfig(request())).success, true);
  response = new Response("{", { status: 200, headers: { "Content-Type": "application/json" } });
  const malformed = await manager.getConfig({ ...request(), forceRefresh: true });
  assert.equal(malformed.success, false);
  assert.equal(malformed.code, "MANAGED_CONFIG_INVALID");
  assert.equal(malformed.enforcementRequired, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, "utf8")).entries, []);
});

test("first authorization and malformed failures keep enforcement unknown", async (t) => {
  for (const scenario of [
    {
      response: jsonResponse({ error: "Sign in with company SSO", code: "SSO_REQUIRED" }, 403),
      code: "SSO_REQUIRED",
    },
    {
      response: jsonResponse({ data: {} }),
      code: "MANAGED_CONFIG_INVALID",
    },
  ]) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
    t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
    const snapshots = [];
    const manager = createEnterpriseIdentityManager({
      cachePath: path.join(tempDir, "config.json"),
      getApiUrl: () => "https://api.example.com",
      getAppVersion: () => "1.8.1",
      proxyFetch: async () => scenario.response,
      tokenStore: { getState: () => ({ token: "session", generation: 4 }) },
      broadcast: (snapshot) => snapshots.push(snapshot),
    });

    const result = await manager.getConfig(request());
    assert.equal(result.code, scenario.code);
    assert.equal(result.enforcementRequired, undefined);
    assert.equal(Object.hasOwn(snapshots.at(-1), "enforcementRequired"), false);
  }
});

test("a prior non-enforced config cannot turn potentially-managed failures into unmanaged", async (t) => {
  const scenarios = [
    { code: "SSO_REQUIRED", status: 403 },
    { code: "AUTH_EXPIRED", status: 401 },
    { code: "DIRECTORY_ASSIGNMENT_REQUIRED", status: 403 },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.code, async (t) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
      t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
      let response = jsonResponse({ data: managedConfig() });
      const snapshots = [];
      const manager = createEnterpriseIdentityManager({
        cachePath: path.join(tempDir, "config.json"),
        getApiUrl: () => "https://api.example.com",
        getAppVersion: () => "1.8.1",
        proxyFetch: async () => response.clone(),
        tokenStore: { getState: () => ({ token: "session", generation: 4 }) },
        broadcast: (snapshot) => snapshots.push(snapshot),
      });

      assert.equal((await manager.getConfig(request())).success, true);
      response = jsonResponse({ error: scenario.code, code: scenario.code }, scenario.status);
      const denied = await manager.getConfig({ ...request(), forceRefresh: true });

      assert.equal(denied.code, scenario.code);
      assert.equal(denied.enforcementRequired, undefined);
      assert.equal(Object.hasOwn(snapshots.at(-1), "enforcementRequired"), false);
    });
  }
});

test("failed identity cache invalidation cannot resurrect an unmanaged disk verdict", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const cachePath = path.join(tempDir, "config.json");
  let mode = "unmanaged";
  const manager = createEnterpriseIdentityManager({
    cachePath,
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => {
      if (mode === "offline") throw new Error("offline");
      if (mode === "unknown") {
        return jsonResponse({ error: "Sign in with company SSO", code: "SSO_REQUIRED" }, 403);
      }
      return jsonResponse(
        { error: "An active Enterprise workspace is required", code: "ENTERPRISE_REQUIRED" },
        403
      );
    },
    tokenStore: { getState: () => ({ token: "session", generation: 4 }) },
  });

  assert.equal((await manager.getConfig(request())).enforcementRequired, false);
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (target, ...args) => {
    if (target === cachePath) throw Object.assign(new Error("read only"), { code: "EACCES" });
    return originalWriteFileSync(target, ...args);
  };
  try {
    mode = "unknown";
    const unknown = await manager.getConfig({ ...request(), forceRefresh: true });
    assert.equal(unknown.enforcementRequired, undefined);
    mode = "offline";
    const offline = await manager.getConfig({ ...request(), forceRefresh: true });
    assert.equal(offline.enforcementRequired, undefined);
    assert.notEqual(offline.code, "ENTERPRISE_REQUIRED");
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
});

test("clear tombstones an unmanaged disk verdict when cache unlink fails", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const cachePath = path.join(tempDir, "config.json");
  let offline = false;
  const manager = createEnterpriseIdentityManager({
    cachePath,
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => {
      if (offline) throw new Error("offline");
      return jsonResponse(
        { error: "An active Enterprise workspace is required", code: "ENTERPRISE_REQUIRED" },
        403
      );
    },
    tokenStore: { getState: () => ({ token: "session", generation: 4 }) },
  });

  assert.equal((await manager.getConfig(request())).enforcementRequired, false);
  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = (target) => {
    if (target === cachePath) throw Object.assign(new Error("read only"), { code: "EACCES" });
    return originalUnlinkSync(target);
  };
  try {
    manager.clear();
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
  offline = true;
  const result = await manager.getConfig({ ...request(), forceRefresh: true });
  assert.equal(result.enforcementRequired, undefined);
  assert.notEqual(result.code, "ENTERPRISE_REQUIRED");
});

test("clear fences an in-flight managed response before any cache or broadcast mutation", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const cachePath = path.join(tempDir, "config.json");
  const firstResponse = deferred();
  const freshResponse = deferred();
  const snapshots = [];
  let calls = 0;
  const manager = createEnterpriseIdentityManager({
    cachePath,
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => {
      calls += 1;
      if (calls === 1) return firstResponse.promise;
      return freshResponse.promise;
    },
    tokenStore: { getState: () => ({ token: "session", generation: 4 }) },
    broadcast: (snapshot) => snapshots.push(snapshot),
  });

  const staleRequest = manager.getConfig(request());
  await new Promise((resolve) => setImmediate(resolve));
  manager.clear();
  const freshRequests = Promise.all([manager.getConfig(request()), manager.getConfig(request())]);
  firstResponse.resolve(jsonResponse({ data: managedConfig() }));

  const staleResult = await staleRequest;
  assert.equal(staleResult.success, false);
  assert.equal(staleResult.code, "AUTH_CONTEXT_CHANGED");
  assert.equal(snapshots.length, 0);
  assert.equal(fs.existsSync(cachePath), false);

  freshResponse.resolve(jsonResponse({ data: managedConfig() }));
  const [freshResult, deduplicatedResult] = await freshRequests;
  assert.equal(freshResult.success, true);
  assert.equal(freshResult.status, "network");
  assert.equal(deduplicatedResult.success, true);
  assert.equal(calls, 2);
  assert.equal(snapshots.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(cachePath, "utf8")).entries.length, 1);
});

test("clear fences an in-flight unmanaged verdict and preserves a failed-unlink tombstone", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const cachePath = path.join(tempDir, "config.json");
  const unmanagedResponse = () =>
    jsonResponse(
      { error: "An active Enterprise workspace is required", code: "ENTERPRISE_REQUIRED" },
      403
    );
  const inFlightResponse = deferred();
  const snapshots = [];
  let mode = "seed";
  const manager = createEnterpriseIdentityManager({
    cachePath,
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => {
      if (mode === "pending") return inFlightResponse.promise;
      if (mode === "offline") throw new Error("offline");
      return unmanagedResponse();
    },
    tokenStore: { getState: () => ({ token: "session", generation: 4 }) },
    broadcast: (snapshot) => snapshots.push(snapshot),
  });

  assert.equal((await manager.getConfig(request())).enforcementRequired, false);
  const broadcastsBeforeClear = snapshots.length;
  mode = "pending";
  const staleRequest = manager.getConfig({ ...request(), forceRefresh: true });
  await new Promise((resolve) => setImmediate(resolve));

  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = (target) => {
    if (target === cachePath) throw Object.assign(new Error("read only"), { code: "EACCES" });
    return originalUnlinkSync(target);
  };
  try {
    manager.clear();
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
  inFlightResponse.resolve(unmanagedResponse());

  const staleResult = await staleRequest;
  assert.equal(staleResult.success, false);
  assert.equal(staleResult.code, "AUTH_CONTEXT_CHANGED");
  assert.equal(snapshots.length, broadcastsBeforeClear);

  mode = "offline";
  const offline = await manager.getConfig({ ...request(), forceRefresh: true });
  assert.equal(offline.enforcementRequired, undefined);
  assert.notEqual(offline.code, "ENTERPRISE_REQUIRED");

  mode = "fresh";
  const freshUnmanaged = await manager.getConfig({ ...request(), forceRefresh: true });
  assert.equal(freshUnmanaged.enforcementRequired, false);
  assert.equal(snapshots.length, broadcastsBeforeClear + 1);
});

test("an unchanged successful refresh does not broadcast an authorization change", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const snapshots = [];
  const manager = createEnterpriseIdentityManager({
    cachePath: path.join(tempDir, "config.json"),
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => jsonResponse({ data: managedConfig() }),
    tokenStore: { getState: () => ({ token: "session", generation: 4 }) },
    broadcast: (snapshot) => snapshots.push(snapshot),
  });

  assert.equal((await manager.getConfig(request())).success, true);
  assert.equal((await manager.getConfig({ ...request(), forceRefresh: true })).success, true);
  assert.equal(snapshots.length, 1);
});

test("a first transient failure does not claim that enforcement is disabled", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const manager = createEnterpriseIdentityManager({
    cachePath: path.join(tempDir, "config.json"),
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => {
      throw new Error("offline");
    },
    tokenStore: { getState: () => ({ token: "session", generation: 4 }) },
  });

  const unavailable = await manager.getConfig(request());
  assert.equal(unavailable.success, false);
  assert.equal(unavailable.enforcementRequired, undefined);
});

test("a missing local API URL returns a stable managed-config error code", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let called = false;
  const manager = createEnterpriseIdentityManager({
    cachePath: path.join(tempDir, "config.json"),
    getApiUrl: () => "",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => {
      called = true;
      return jsonResponse({ data: managedConfig() });
    },
    tokenStore: { getState: () => ({ token: "session", generation: 4 }) },
  });

  const result = await manager.getConfig(request());

  assert.equal(result.success, false);
  assert.equal(result.code, "MANAGED_CONFIG_UNAVAILABLE");
  assert.equal(called, false);
});

test("a response without server detail uses a stable code while supplied detail remains raw", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let response = new Response("upstream unavailable", {
    status: 502,
    headers: { "Content-Type": "text/plain" },
  });
  const manager = createEnterpriseIdentityManager({
    cachePath: path.join(tempDir, "config.json"),
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => response.clone(),
    tokenStore: { getState: () => ({ token: "session", generation: 4 }) },
  });

  const generatedFallback = await manager.getConfig(request());

  assert.equal(generatedFallback.success, false);
  assert.equal(generatedFallback.code, "MANAGED_CONFIG_UNAVAILABLE");

  response = jsonResponse({ error: "The enterprise gateway returned status 502." }, 502);
  const suppliedDetail = await manager.getConfig({ ...request(), forceRefresh: true });

  assert.equal(suppliedDetail.success, false);
  assert.equal(suppliedDetail.code, "MANAGED_CONFIG_FAILED");
  assert.equal(suppliedDetail.error, "The enterprise gateway returned status 502.");
});

test("generic and unknown JSON codes without detail become unavailable", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let response;
  const manager = createEnterpriseIdentityManager({
    cachePath: path.join(tempDir, "config.json"),
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => response.clone(),
    tokenStore: { getState: () => ({ token: "session", generation: 4 }) },
  });

  for (const code of ["MANAGED_CONFIG_FAILED", "UNRECOGNIZED_CONFIG_FAILURE"]) {
    await t.test(code, async () => {
      response = jsonResponse({ code }, 502);
      const result = await manager.getConfig({ ...request(), forceRefresh: true });

      assert.equal(result.success, false);
      assert.equal(result.code, "MANAGED_CONFIG_UNAVAILABLE");
    });
  }
});

test("a code-only identity failure remains actionable", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const manager = createEnterpriseIdentityManager({
    cachePath: path.join(tempDir, "config.json"),
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => jsonResponse({ code: "SSO_REQUIRED" }, 403),
    tokenStore: { getState: () => ({ token: "session", generation: 4 }) },
  });

  const actionableIdentityFailure = await manager.getConfig(request());

  assert.equal(actionableIdentityFailure.success, false);
  assert.equal(actionableIdentityFailure.code, "SSO_REQUIRED");
});

test("a generation change discards old cloud credentials and broadcasts the new envelope", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let generation = 1;
  let tokenCalls = 0;
  const snapshots = [];
  const manager = createEnterpriseIdentityManager({
    cachePath: path.join(tempDir, "config.json"),
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch: async (url) => {
      if (url.includes("/assertion")) {
        return jsonResponse({ data: { assertion: `assertion-${generation}` } });
      }
      if (url.startsWith("https://login.microsoftonline.com/")) {
        tokenCalls += 1;
        return jsonResponse({ access_token: `token-${generation}`, expires_in: 3600 });
      }
      const config = managedConfig();
      config.generation = generation;
      return jsonResponse({ data: config });
    },
    tokenStore: { getState: () => ({ token: "session", generation: 4 }) },
    broadcast: (snapshot) => snapshots.push(snapshot),
  });

  const first = await manager.resolveProvider(request());
  assert.equal(await first.tokenProvider(), "token-1");
  generation = 2;
  await manager.getConfig({ ...request(), forceRefresh: true });
  const second = await manager.resolveProvider(request());
  assert.equal(await second.tokenProvider(), "token-2");
  assert.equal(tokenCalls, 2);
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.config?.generation),
    [1, 2]
  );
});

test("rejects stale auth generations before making a request", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let called = false;
  const manager = createEnterpriseIdentityManager({
    cachePath: path.join(tempDir, "config.json"),
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch: async () => {
      called = true;
      return jsonResponse({ data: managedConfig() });
    },
    tokenStore: { getState: () => ({ token: "session", generation: 5 }) },
  });

  const result = await manager.getConfig(request());
  assert.equal(result.success, false);
  assert.equal(result.code, "AUTH_CONTEXT_CHANGED");
  assert.equal(called, false);
});

test("Bedrock exchanges the workspace assertion for short-lived web identity credentials", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-enterprise-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const config = managedConfig();
  config.providers = [
    {
      provider: "bedrock",
      mode: "managed_required",
      allowManualSetup: false,
      config: {
        roleArn: "arn:aws:iam::123456789012:role/OpenWhispr",
        region: "us-west-2",
        allowedModels: ["model-a"],
        scopeDefaults: Object.fromEntries(
          Object.keys(config.providers[0].config.scopeDefaults).map((scope) => [scope, "model-a"])
        ),
      },
      version: 2,
      updatedAt: "2026-08-10T00:00:00.000Z",
    },
  ];
  let providerInit;
  let providerCalls = 0;
  const manager = createEnterpriseIdentityManager({
    cachePath: path.join(tempDir, "config.json"),
    getApiUrl: () => "https://api.example.com",
    getAppVersion: () => "1.8.1",
    proxyFetch: async (url) =>
      url.includes("/assertion")
        ? jsonResponse({ data: { assertion: "workspace-assertion" } })
        : jsonResponse({ data: config }),
    tokenStore: {
      getState: () => ({ token: "openwhispr-session", generation: 4 }),
    },
    createAwsWebIdentityProvider: (init) => {
      providerInit = init;
      return async () => {
        providerCalls += 1;
        return {
          accessKeyId: "temporary-access-key",
          secretAccessKey: "temporary-secret",
          sessionToken: "temporary-session",
          expiration: new Date(Date.now() + 15 * 60 * 1000),
        };
      };
    },
  });

  const runtime = await manager.resolveProvider(request({ setupMode: "manual" }));
  const first = await runtime.credentialProvider();
  const second = await runtime.credentialProvider();
  assert.equal(first.accessKeyId, "temporary-access-key");
  assert.equal(second.accessKeyId, "temporary-access-key");
  assert.equal(providerCalls, 1);
  assert.deepEqual(providerInit, {
    roleArn: "arn:aws:iam::123456789012:role/OpenWhispr",
    roleSessionName: `openwhispr-${workspaceId.slice(0, 8)}`,
    webIdentityToken: "workspace-assertion",
    durationSeconds: 900,
    clientConfig: { region: "us-west-2" },
  });
});
