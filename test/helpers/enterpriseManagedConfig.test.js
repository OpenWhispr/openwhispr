const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveManagedEnterpriseScope,
  validateManagedEnterpriseEnvelope,
  managedScopesForConfig,
} = require("../../src/helpers/enterpriseManagedConfig.mjs");

const scopes = {
  dictationCleanup: "model-a",
  dictationAgent: "model-a",
  noteFormatting: "model-a",
  chatIntelligence: "model-a",
  dictationTranslation: "model-a",
};

function provider(overrides = {}) {
  return {
    provider: "bedrock",
    mode: "managed_default",
    allowManualSetup: true,
    config: {
      roleArn: "arn:aws:iam::123456789012:role/OpenWhispr",
      region: "us-east-1",
      allowedModels: ["model-a"],
      scopeDefaults: scopes,
    },
    version: 1,
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

function envelope(providers = [provider()]) {
  return {
    workspaceId: "workspace-a",
    version: 1,
    identity: {
      issuer: "https://api.example.com/enterprise-identity",
      jwksUri: "https://api.example.com/enterprise-identity/jwks.json",
      subject: "workspace:workspace-a",
      audiences: { bedrock: "sts.amazonaws.com", azure: "api://AzureADTokenExchange" },
    },
    providers,
  };
}

test("validates safe managed configuration and rejects unknown models", () => {
  assert.ok(validateManagedEnterpriseEnvelope(envelope(), "workspace-a"));
  const invalid = envelope([
    provider({
      config: {
        ...provider().config,
        scopeDefaults: { ...scopes, dictationCleanup: "not-allowed" },
      },
    }),
  ]);
  assert.equal(validateManagedEnterpriseEnvelope(invalid, "workspace-a"), null);
  assert.equal(
    validateManagedEnterpriseEnvelope(
      envelope([
        provider({
          config: {
            ...provider().config,
            scopeDefaults: { dictationCleanup: "model-a" },
          },
        }),
      ]),
      "workspace-a"
    ),
    null
  );
});

test("rejects unsafe cached cloud destinations and identity metadata", () => {
  const unsafeAzure = provider({
    provider: "azure",
    config: {
      tenantId: "11111111-1111-4111-8111-111111111111",
      clientId: "22222222-2222-4222-8222-222222222222",
      endpoint: "https://openai.azure.com.evil.example",
      apiVersion: "v1",
      allowedDeployments: ["deployment-a"],
      scopeDefaults: Object.fromEntries(
        Object.keys(scopes).map((scope) => [scope, "deployment-a"])
      ),
    },
  });
  assert.equal(validateManagedEnterpriseEnvelope(envelope([unsafeAzure]), "workspace-a"), null);
  assert.equal(
    validateManagedEnterpriseEnvelope(
      { ...envelope(), identity: { ...envelope().identity, subject: "workspace:other" } },
      "workspace-a"
    ),
    null
  );
});

test("managed default preserves an explicit legacy manual setup", () => {
  assert.equal(
    resolveManagedEnterpriseScope(envelope(), "dictationCleanup", "manual").kind,
    "manual"
  );
  assert.deepEqual(resolveManagedEnterpriseScope(envelope(), "dictationCleanup", "auto"), {
    kind: "managed",
    provider: "bedrock",
    model: "model-a",
    mode: "managed_default",
    allowManualSetup: true,
    record: provider(),
  });
});

test("required managed access overrides manual setup", () => {
  const result = resolveManagedEnterpriseScope(
    envelope([provider({ mode: "managed_required", allowManualSetup: false })]),
    "chatIntelligence",
    "manual"
  );
  assert.equal(result.kind, "managed");
  assert.equal(result.model, "model-a");
});

test("an ambiguous cached provider switch fails closed", () => {
  const azure = provider({
    provider: "azure",
    updatedAt: "2026-08-11T00:00:00.000Z",
    config: {
      tenantId: "11111111-1111-4111-8111-111111111111",
      clientId: "22222222-2222-4222-8222-222222222222",
      endpoint: "https://example.openai.azure.com",
      apiVersion: "v1",
      allowedDeployments: ["deployment-a"],
      scopeDefaults: Object.fromEntries(
        Object.keys(scopes).map((scope) => [scope, "deployment-a"])
      ),
    },
  });
  const result = resolveManagedEnterpriseScope(
    envelope([provider(), azure]),
    "dictationCleanup",
    "auto"
  );
  assert.equal(result.kind, "error");
  assert.equal(result.code, "MANAGED_CONFIG_AMBIGUOUS");
});

test("accepts Azure resource and Foundry endpoints, rejects sovereign and path-qualified ones", () => {
  const makeAzure = (endpoint) =>
    provider({
      provider: "azure",
      config: {
        tenantId: "11111111-1111-4111-8111-111111111111",
        clientId: "22222222-2222-4222-8222-222222222222",
        endpoint,
        apiVersion: "v1",
        allowedDeployments: ["deployment-a"],
        scopeDefaults: Object.fromEntries(
          Object.keys(scopes).map((scope) => [scope, "deployment-a"])
        ),
      },
    });
  for (const endpoint of [
    "https://example.openai.azure.com",
    "https://example.services.ai.azure.com",
    "https://example.cognitiveservices.azure.com",
  ]) {
    assert.ok(validateManagedEnterpriseEnvelope(envelope([makeAzure(endpoint)]), "workspace-a"));
  }
  for (const endpoint of [
    "https://example.openai.azure.us",
    "https://services.ai.azure.com",
    "https://example.openai.azure.com/openai",
  ]) {
    assert.equal(
      validateManagedEnterpriseEnvelope(envelope([makeAzure(endpoint)]), "workspace-a"),
      null
    );
  }
});

test("accepts dated Azure versions from previously issued managed envelopes", () => {
  const azure = provider({
    provider: "azure",
    config: {
      tenantId: "11111111-1111-4111-8111-111111111111",
      clientId: "22222222-2222-4222-8222-222222222222",
      endpoint: "https://example.openai.azure.com",
      apiVersion: "2024-10-21",
      allowedDeployments: ["deployment-a"],
      scopeDefaults: Object.fromEntries(
        Object.keys(scopes).map((scope) => [scope, "deployment-a"])
      ),
    },
  });
  assert.ok(validateManagedEnterpriseEnvelope(envelope([azure]), "workspace-a"));
  azure.config.apiVersion = "latest";
  assert.equal(validateManagedEnterpriseEnvelope(envelope([azure]), "workspace-a"), null);
});

const azureBase = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222",
  endpoint: "https://example.services.ai.azure.com",
  apiVersion: "v1",
};

function azureProvider(config, overrides = {}) {
  return provider({ provider: "azure", config: { ...azureBase, ...config }, ...overrides });
}

test("Azure sections are independent but at least one is required", () => {
  const transcription = {
    allowedDeployments: ["gpt-4o-transcribe"],
    defaultDeployment: "gpt-4o-transcribe",
  };
  assert.ok(
    validateManagedEnterpriseEnvelope(envelope([azureProvider({ transcription })]), "workspace-a")
  );
  assert.ok(
    validateManagedEnterpriseEnvelope(
      envelope([
        azureProvider({
          allowedDeployments: ["gpt-4.1"],
          scopeDefaults: Object.fromEntries(Object.keys(scopes).map((scope) => [scope, "gpt-4.1"])),
          transcription,
        }),
      ]),
      "workspace-a"
    )
  );
  // Neither section, a partial text section, and an out-of-list default all fail.
  for (const config of [
    {},
    { allowedDeployments: ["gpt-4.1"] },
    { transcription: { ...transcription, defaultDeployment: "unapproved" } },
  ]) {
    assert.equal(
      validateManagedEnterpriseEnvelope(envelope([azureProvider(config)]), "workspace-a"),
      null
    );
  }
});

test("the transcription scope resolves from the Azure transcription section only", () => {
  const transcription = {
    allowedDeployments: ["gpt-4o-transcribe"],
    defaultDeployment: "gpt-4o-transcribe",
  };
  const sttOnly = envelope([azureProvider({ transcription })]);
  const resolved = resolveManagedEnterpriseScope(sttOnly, "transcription");
  assert.equal(resolved.kind, "managed");
  assert.equal(resolved.provider, "azure");
  assert.equal(resolved.model, "gpt-4o-transcribe");
  // The LLM scopes stay manual on an STT-only record.
  assert.equal(resolveManagedEnterpriseScope(sttOnly, "dictationCleanup").kind, "manual");
  // A text-only workspace (bedrock) has no managed transcription.
  assert.equal(resolveManagedEnterpriseScope(envelope(), "transcription").kind, "manual");
  // A user opt-out is honored unless the provider is enforced.
  assert.equal(resolveManagedEnterpriseScope(sttOnly, "transcription", "manual").kind, "manual");
  const enforced = envelope([azureProvider({ transcription }, { mode: "managed_required" })]);
  assert.equal(resolveManagedEnterpriseScope(enforced, "transcription", "manual").kind, "managed");
});

test("managedScopesForConfig lists the scopes each active record carries, split by enforcement", () => {
  const transcription = {
    allowedDeployments: ["gpt-4o-transcribe"],
    defaultDeployment: "gpt-4o-transcribe",
  };
  const llmRequired = envelope([provider({ mode: "managed_required", allowManualSetup: false })]);
  assert.deepEqual(managedScopesForConfig(llmRequired), {
    managed: Object.keys(scopes),
    enforced: Object.keys(scopes),
  });
  const sttDefault = envelope([azureProvider({ transcription })]);
  assert.deepEqual(managedScopesForConfig(sttDefault), {
    managed: ["transcription"],
    enforced: [],
  });
  const sttLocked = envelope([azureProvider({ transcription }, { allowManualSetup: false })]);
  assert.deepEqual(managedScopesForConfig(sttLocked), {
    managed: ["transcription"],
    enforced: ["transcription"],
  });
  assert.deepEqual(managedScopesForConfig(null), { managed: [], enforced: [] });
  assert.deepEqual(managedScopesForConfig(envelope([provider({ mode: "disabled" })])), {
    managed: [],
    enforced: [],
  });
});
