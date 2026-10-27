const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  registerEnterpriseAudioSetup,
  configFingerprint,
} = require("../../src/helpers/enterpriseAudioSetup");

function setup({ bootstrapDirectory } = {}) {
  const handlers = new Map();
  const writes = [];
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
    fetchApi: async () => ({ ...record }),
    bootstrapDirectory,
    credentials: {
      save: async (...args) => writes.push(args),
      saveMany: async (...args) => writes.push(args),
      status: async () => ({ present: false }),
    },
    runtime: {
      resolve: async () => {
        probes++;
        throw new Error("Unexpected audio probe");
      },
    },
  });
  return {
    binding,
    record,
    context,
    writes,
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

test("a draft Azure device test uses the network stack the managed route will use", async () => {
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
    },
  };
  const fingerprint = configFingerprint("azure", record.config);
  const binding = { accountId: "account-a", workspaceId: "workspace-a", authGeneration: 1 };
  const systemRequests = [];
  const transportRequests = [];
  registerEnterpriseAudioSetup({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    getRequest: async () => ({ ...binding, expectedAuthGeneration: 1 }),
    fetchApi: async (_request, endpoint, { method = "GET" } = {}) => {
      if (endpoint.endsWith("/device-checks")) return {};
      if (endpoint.endsWith("/test-context"))
        return method === "POST"
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
    systemFetch: async (url) => {
      systemRequests.push(url);
      return new Response(
        JSON.stringify(
          url.startsWith("https://login.microsoftonline.com/")
            ? { access_token: "entra", expires_in: 3600 }
            : { text: "" }
        )
      );
    },
    getVersion: () => "0.0.0",
  });
  const result = await handlers.get("enterprise-audio-test")(
    {},
    {
      provider: "azure",
      operation: "batch",
      allowInferenceValidation: true,
      context: { ...binding, generation: 1, providerVersion: 1, configFingerprint: fingerprint },
    }
  );
  assert.deepEqual(transportRequests, []);
  assert.equal(result.code, "OK");
  assert.equal(systemRequests.length, 2);
  assert.match(systemRequests[0], /^https:\/\/login\.microsoftonline\.com\//);
  assert.match(systemRequests[1], /^https:\/\/acme\.openai\.azure\.com\/openai\//);
});
