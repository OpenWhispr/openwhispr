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
      enterpriseTranscription: "none",
      transcriptionProviders: TRANSCRIPTION_PROVIDERS,
      llmProviders: LLM_PROVIDERS,
      managedEnterpriseAvailable: false,
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

test("manual enterprise exposes only providers onboarding can configure", async () => {
  const enterprisePolicy = (provider) =>
    managedPolicy({
      transcription: { allowedModes: ["openwhispr"], allowedByokProviders: [] },
      llm: {
        allowedModes: ["enterprise"],
        allowedByokProviders: [],
        allowedEnterpriseProviders: [provider],
      },
    });

  assert.equal((await availability(enterprisePolicy("vertex"))).enterprise, false);
  assert.equal((await availability(enterprisePolicy("bedrock"))).enterprise, true);
  assert.equal((await availability(enterprisePolicy("azure"))).enterprise, true);
});

test("enterprise is blocked when transcription has no policy-compliant setup", async () => {
  const policy = managedPolicy({
    transcription: { allowedModes: [], allowedByokProviders: [] },
    llm: {
      allowedModes: ["enterprise"],
      allowedByokProviders: [],
      allowedEnterpriseProviders: ["bedrock"],
    },
  });

  const result = await availability(policy, { enterpriseTranscription: "unavailable" });
  assert.equal(result.enterprise, false);
  assert.deepEqual(result, {
    cloud: false,
    local: false,
    byok: false,
    selfHosted: false,
    enterprise: false,
  });
});
