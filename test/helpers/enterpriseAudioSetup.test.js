const test = require("node:test");
const assert = require("node:assert/strict");
const {
  registerEnterpriseAudioSetup,
  configFingerprint,
} = require("../../src/helpers/enterpriseAudioSetup");

function setup() {
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
    config: { batch: { authentication: { credentialSlot: "http" } } },
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
    credentials: {
      save: async (...args) => writes.push(args),
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
