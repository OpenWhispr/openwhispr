const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/onboarding/setupEligibility.ts");

const TRANSCRIPTION_PROVIDERS = [{ id: "openai" }, { id: "groq" }];
const LLM_PROVIDERS = [{ id: "anthropic" }, { id: "groq" }];

function managedPolicy({ transcription, llm }) {
  return {
    status: "managed",
    appVersion: "1.0.0",
    policy: {
      version: 1,
      transcription,
      llm,
      features: { agentEnabled: true, webSearchEnabled: true },
      sharing: { externalLinkSharing: "allowed" },
      dataRetention: {
        audioRetentionMaxDays: null,
        localHistoryMode: "user_choice",
        cloudBackupAllowed: true,
      },
      minAppVersion: null,
    },
  };
}

function availability(policy, overrides = {}) {
  return load().then(({ getOnboardingSetupAvailability }) =>
    getOnboardingSetupAvailability({
      policy,
      agentAllowed: true,
      transcriptionProviders: TRANSCRIPTION_PROVIDERS,
      llmProviders: LLM_PROVIDERS,
      ...overrides,
    })
  );
}

test("BYOK requires a usable provider for both stages", async () => {
  const base = {
    transcription: { allowedModes: ["providers"], allowedByokProviders: [] },
    llm: {
      allowedModes: ["providers"],
      allowedByokProviders: [],
      allowedEnterpriseProviders: [],
    },
  };
  assert.equal((await availability(managedPolicy(base))).byok, false);

  base.transcription.allowedByokProviders = ["groq"];
  assert.equal((await availability(managedPolicy(base))).byok, false);

  base.llm.allowedByokProviders = ["anthropic"];
  assert.equal((await availability(managedPolicy(base))).byok, true);
});

test("self-hosted eligibility is independent from hosted provider mode", async () => {
  const result = await availability(
    managedPolicy({
      transcription: { allowedModes: ["self-hosted"], allowedByokProviders: ["custom"] },
      llm: {
        allowedModes: ["self-hosted"],
        allowedByokProviders: ["custom"],
        allowedEnterpriseProviders: [],
      },
    })
  );

  assert.equal(result.byok, false);
  assert.equal(result.selfHosted, true);
});

test("availability reports no setup when policy permits no onboarding mode", async () => {
  const policy = managedPolicy({
    transcription: { allowedModes: [], allowedByokProviders: [] },
    llm: {
      allowedModes: [],
      allowedByokProviders: [],
      allowedEnterpriseProviders: [],
    },
  });

  const result = await availability(policy);
  assert.deepEqual(result, {
    cloud: false,
    local: false,
    byok: false,
    selfHosted: false,
  });
});

test("dictation-only policies ignore LLM availability when the agent is disabled", async () => {
  const policy = managedPolicy({
    transcription: {
      allowedModes: ["openwhispr", "local", "providers", "self-hosted"],
      allowedByokProviders: ["groq", "custom"],
    },
    llm: {
      allowedModes: [],
      allowedByokProviders: [],
      allowedEnterpriseProviders: [],
    },
  });
  policy.policy.features.agentEnabled = false;

  assert.deepEqual(await availability(policy, { agentAllowed: true }), {
    cloud: false,
    local: false,
    byok: false,
    selfHosted: false,
  });

  const result = await availability(policy, { agentAllowed: false });
  assert.deepEqual(result, {
    cloud: true,
    local: true,
    byok: true,
    selfHosted: true,
  });
});
