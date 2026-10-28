const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  registerEnterpriseAudioSetup,
  configFingerprint,
  safeCheckCode,
} = require("../../src/helpers/enterpriseAudioSetup");

function setup({ bootstrapDirectory, resolve } = {}) {
  const handlers = new Map();
  const writes = [];
  const reports = [];
  let probes = 0;
  const binding = {
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    generation: 1,
  };
  const record = {
    version: 2,
    mode: "managed_default",
    config: {
      batch: { authentication: { credentialSlot: "http" } },
      network: { proxy: { mode: "system", credentialSlot: "proxy" } },
    },
  };
  const context = {
    ...binding,
    providerVersion: record.version,
    configFingerprint: configFingerprint("openai-compatible", record.config),
  };
  registerEnterpriseAudioSetup({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    getRequest: async (_event, expected) => {
      if (Object.keys(binding).some((key) => expected[key] !== binding[key]))
        throw Object.assign(new Error("changed"), { code: "AUTH_CONTEXT_CHANGED" });
      return { ...binding, expectedAuthGeneration: binding.authGeneration };
    },
    fetchApi: async (_request, endpoint, init = {}) => {
      if (endpoint.endsWith("/device-checks")) reports.push(init.body);
      return { ...record };
    },
    getVersion: () => "0.0.0",
    bootstrapDirectory,
    credentials: {
      save: async (...args) => writes.push(args),
      saveMany: async (...args) => writes.push(args),
      status: async () => ({ present: false }),
    },
    runtime: {
      resolve: async (...args) => {
        probes++;
        if (resolve) return resolve(...args);
        throw new Error("Unexpected audio probe");
      },
    },
  });
  return {
    binding,
    record,
    context,
    writes,
    reports,
    probes: () => probes,
    invoke: (name, input) =>
      handlers.get(`enterprise-audio-${name}`)({}, { provider: "openai-compatible", ...input }),
  };
}

test("stale setup identity cannot provision a credential in the newly selected workspace", async () => {
  const fixture = setup();
  fixture.binding.workspaceId = "workspace-b";
  const result = await fixture.invoke("save-credential", {
    context: fixture.context,
    slot: "http",
    secret: "local-test",
  });
  assert.equal(result.success, false);
  assert.equal(result.code, "CONFIG_CHANGED");
  assert.deepEqual(fixture.writes, []);
});

test("setup status binds consent to the exact provider configuration before saving or probing", async () => {
  const fixture = setup();
  const status = await fixture.invoke("status", { context: fixture.context });
  assert.equal(status.configFingerprint, fixture.context.configFingerprint);
  assert.equal(
    (
      await fixture.invoke("save-credential", {
        context: fixture.context,
        slot: "http",
        secret: "local-test",
      })
    ).success,
    true
  );
  assert.deepEqual(fixture.writes[0], ["account-a", "workspace-a", "http", "local-test"]);
  fixture.record.config.batch.endpoint = "https://replacement.test/transcribe";
  const result = await fixture.invoke("test", {
    context: fixture.context,
    operation: "batch",
    allowInferenceValidation: true,
  });
  assert.equal(result.code, "CONFIG_CHANGED");
  assert.equal(fixture.probes(), 0);
  fixture.record.version++;
  assert.equal((await fixture.invoke("status", { context: fixture.context })).success, false);
});

test("setup mutations reject missing configuration consent context", async () => {
  const fixture = setup();
  const result = await fixture.invoke("save-credential", { slot: "http", secret: "local-test" });
  assert.equal(result.success, false);
  assert.deepEqual(fixture.writes, []);
});

test("a proxy slot only accepts a {username, password} credential", async () => {
  const fixture = setup();
  for (const secret of ["proxy-password", JSON.stringify({ username: "a:b", password: "p" })]) {
    const result = await fixture.invoke("save-credential", {
      context: fixture.context,
      slot: "proxy",
      secret,
    });
    assert.equal(result.success, false);
  }
  assert.deepEqual(fixture.writes, []);
  const secret = JSON.stringify({ username: "user", password: "p:w" });
  assert.equal(
    (await fixture.invoke("save-credential", { context: fixture.context, slot: "proxy", secret }))
      .success,
    true
  );
  assert.equal(
    (
      await fixture.invoke("save-credential", {
        context: fixture.context,
        slot: "http",
        secret: "local-test",
      })
    ).success,
    true
  );
  assert.equal(fixture.writes.length, 2);
});

test(
  "a bootstrap file cannot import a malformed proxy credential",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ow-audio-bootstrap-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const fixture = setup({ bootstrapDirectory: directory });
    const write = (credentials) =>
      fs.writeFileSync(
        path.join(directory, "enterprise-audio-bootstrap.json"),
        JSON.stringify({
          version: 1,
          accountId: "account-a",
          workspaceId: "workspace-a",
          credentials,
        }),
        { mode: 0o600 }
      );
    write({ http: "local-test", proxy: "proxy-password" });
    const rejected = await fixture.invoke("import-bootstrap", { context: fixture.context });
    assert.equal(rejected.success, false);
    assert.deepEqual(fixture.writes, []);
    write({ http: "local-test", proxy: JSON.stringify({ username: "user", password: "p" }) });
    const imported = await fixture.invoke("import-bootstrap", { context: fixture.context });
    assert.equal(imported.success, true);
    assert.equal(imported.imported, true);
    assert.equal(fixture.writes.length, 1);
  }
);

test("a policy or setup refusal before the probe is shown and never reported as a device check", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ow-audio-refusal-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const refusal = (code, messageKey) => async () => {
    throw Object.assign(new Error(code), { code, ...(messageKey ? { messageKey } : {}) });
  };
  for (const [resolve, code, messageKey] of [
    [refusal("POLICY_UNRESOLVABLE"), "POLICY_UNRESOLVABLE", "common.policyUnresolved"],
    [
      refusal("PROVIDER_POLICY_CONFLICT", "common.managedPolicyConflict"),
      "PROVIDER_POLICY_CONFLICT",
      "common.managedPolicyConflict",
    ],
    [
      refusal("MANAGED_OPERATION_UNAVAILABLE", "enterprise.audio.operationUnavailable"),
      "MANAGED_OPERATION_UNAVAILABLE",
      "enterprise.audio.operationUnavailable",
    ],
    [
      refusal("MANAGED_CONFIG_AMBIGUOUS", "common.managedConfigAmbiguous"),
      "MANAGED_CONFIG_AMBIGUOUS",
      "common.managedConfigAmbiguous",
    ],
    [
      refusal("BOOTSTRAP_UNREADABLE", "enterprise.audio.bootstrapUnreadable"),
      "BOOTSTRAP_UNREADABLE",
      "enterprise.audio.bootstrapUnreadable",
    ],
    // Manual setup leaves no managed profile to probe.
    [async () => null, "MANAGED_OPERATION_UNAVAILABLE", "enterprise.audio.operationUnavailable"],
  ]) {
    const fixture = setup({ bootstrapDirectory: directory, resolve });
    const result = await fixture.invoke("test", {
      context: fixture.context,
      operation: "batch",
      allowInferenceValidation: true,
    });
    assert.deepEqual(result, { success: false, code, messageKey });
    assert.deepEqual(fixture.reports, []);
  }
});

function draftAzureSetup(t, { config = {}, fetchApi, systemFetch } = {}) {
  const handlers = new Map();
  const record = {
    version: 1,
    mode: "disabled",
    config: {
      endpoint: "https://acme.openai.azure.com",
      apiVersion: "v1",
      tenantId: "22222222-2222-4222-8222-222222222222",
      clientId: "33333333-3333-4333-8333-333333333333",
      transcription: { defaultDeployment: "speech" },
      ...config,
    },
  };
  const fingerprint = configFingerprint("azure", record.config);
  const binding = { accountId: "account-a", workspaceId: "workspace-a", authGeneration: 1 };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ow-audio-device-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const systemRequests = [];
  const transportRequests = [];
  const reports = [];
  registerEnterpriseAudioSetup({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    getRequest: async () => ({ ...binding, expectedAuthGeneration: 1 }),
    fetchApi: async (request, endpoint, init = {}) => {
      if (endpoint.endsWith("/device-checks")) {
        reports.push(init.body);
        return {};
      }
      const answer = await fetchApi?.(endpoint, init);
      if (answer) return answer;
      if (endpoint.endsWith("/test-context"))
        return init.method === "POST"
          ? { assertion: "signed" }
          : { record, configFingerprint: fingerprint, certificateBundles: [] };
      return { ...record };
    },
    credentials: { generation: 0 },
    transport: {
      request: async (url) => {
        transportRequests.push(url);
        throw new Error("The legacy Azure shape must not use the Node transport");
      },
    },
    systemFetch: async (url, init) => {
      systemRequests.push(url);
      if (systemFetch) return systemFetch(url, init);
      return new Response(
        JSON.stringify(
          url.startsWith("https://login.microsoftonline.com/")
            ? { access_token: "entra", expires_in: 3600 }
            : { text: "" }
        )
      );
    },
    getVersion: () => "0.0.0",
    bootstrapDirectory: directory,
  });
  return {
    reports,
    systemRequests,
    transportRequests,
    test: () =>
      handlers.get("enterprise-audio-test")(
        {},
        {
          provider: "azure",
          operation: "batch",
          allowInferenceValidation: true,
          context: {
            ...binding,
            generation: 1,
            providerVersion: 1,
            configFingerprint: fingerprint,
          },
        }
      ),
  };
}

test("a draft Azure device test uses the network stack the managed route will use", async (t) => {
  const fixture = draftAzureSetup(t);
  const result = await fixture.test();
  assert.deepEqual(fixture.transportRequests, []);
  assert.equal(result.code, "OK");
  assert.equal(result.messageKey, "enterprise.audio.testPassed");
  assert.equal(fixture.systemRequests.length, 2);
  assert.match(fixture.systemRequests[0], /^https:\/\/login\.microsoftonline\.com\//);
  assert.match(fixture.systemRequests[1], /^https:\/\/acme\.openai\.azure\.com\/openai\//);
});

test("device checks carry a random per-install id, never one derived from the host", async (t) => {
  const fixture = draftAzureSetup(t);
  await fixture.test();
  await fixture.test();
  const [first, second] = fixture.reports.map((report) => report.deviceId);
  assert.match(first, /^[a-f0-9]{32}$/);
  assert.equal(second, first);
  assert.notEqual(
    first,
    crypto.createHash("sha256").update(os.hostname()).digest("hex").slice(0, 32)
  );
});

test("an OpenWhispr API refusal is shown on the device and never reported as a device check", async (t) => {
  for (const [status, code, expected, messageKey] of [
    [403, "SSO_REQUIRED", "SSO_REQUIRED", "enterprise.audio.errors.ssoRequired"],
    [
      403,
      "ENTERPRISE_REQUIRED",
      "ENTERPRISE_REQUIRED",
      "enterprise.audio.errors.enterpriseRequired",
    ],
    [409, "MANAGED_CONFIG_CHANGED", "CONFIG_CHANGED", "enterprise.audio.checks.configChanged"],
    [429, undefined, "RATE_LIMITED", "enterprise.audio.errors.rateLimited"],
  ]) {
    const fixture = draftAzureSetup(t, {
      fetchApi: async (endpoint, init) => {
        if (endpoint.endsWith("/test-context") && init.method === "POST")
          throw Object.assign(new Error(`Enterprise setup request failed (${status})`), {
            status,
            code,
          });
      },
    });
    const result = await fixture.test();
    assert.deepEqual(result, { success: false, code: expected, messageKey });
    assert.deepEqual(fixture.reports, []);
  }
});

test("device failures carry a translated message and report a code the API accepts", async (t) => {
  const tls = draftAzureSetup(t, {
    systemFetch: async () => {
      throw Object.assign(new Error("self-signed"), { code: "SELF_SIGNED_CERT_IN_CHAIN" });
    },
  });
  assert.deepEqual(await tls.test(), {
    success: true,
    passed: false,
    code: "TLS_FAILED",
    operation: "batch",
    messageKey: "enterprise.audio.checks.tlsFailed",
  });
  assert.equal(tls.reports[0].code, "TLS_FAILED");

  const missingCa = draftAzureSetup(t, { config: { network: { caBundleId: "corporate" } } });
  const result = await missingCa.test();
  assert.equal(result.code, "CA_UNAVAILABLE");
  assert.equal(result.messageKey, "enterprise.audio.certificateUnavailable");
  assert.equal(missingCa.reports[0].code, "TLS_FAILED");
});

test("secure-storage and CA failures keep their own codes locally", () => {
  assert.equal(
    safeCheckCode({ code: "SECURE_STORAGE_UNAVAILABLE", message: "unavailable" }),
    "SECURE_STORAGE_UNAVAILABLE"
  );
  assert.equal(safeCheckCode({ code: "MANAGED_CA_UNAVAILABLE" }), "CA_UNAVAILABLE");
  assert.equal(
    safeCheckCode({ code: "IDENTITY_EXCHANGE_FAILED", message: "AADSTS" }),
    "AUTH_REJECTED"
  );
  assert.equal(safeCheckCode({ status: 401, message: "(401)" }), "SIGN_IN_REQUIRED");
});

const FINGERPRINT_SAMPLE = {
  endpoint: "https://x.openai.azure.com/path",
  tenantId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222",
  apiVersion: "v1",
  scopeDefaults: { hotkey: "a", dictationCleanup: "b", chatIntelligence: "c" },
  network: { connectTimeoutMs: 15000 },
};
// Pinned: the API computes the same value for the same record.
const FINGERPRINT_SAMPLE_HASH = "016cb96459ca4a132b364c41bdb1618023fcff5f49da28971e0cc92877349645";

test("the configuration fingerprint sorts keys by code unit, whatever the locale", () => {
  assert.equal(configFingerprint("azure", FINGERPRINT_SAMPLE), FINGERPRINT_SAMPLE_HASH);
  const localeCompare = String.prototype.localeCompare;
  // Czech collates "ch" after "h", which would reorder chatIntelligence.
  String.prototype.localeCompare = function (other) {
    return localeCompare.call(this, other, "cs");
  };
  try {
    assert.equal(configFingerprint("azure", FINGERPRINT_SAMPLE), FINGERPRINT_SAMPLE_HASH);
  } finally {
    String.prototype.localeCompare = localeCompare;
  }
});
