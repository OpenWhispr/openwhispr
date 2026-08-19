const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/onboarding/enterpriseTranscription.ts");

const PROVIDERS = [{ id: "openai" }, { id: "groq" }, { id: "custom" }];

const managedPolicy = (transcription) => ({
  status: "managed",
  appVersion: "1.0.0",
  policy: {
    version: 1,
    transcription,
    llm: {
      allowedModes: ["enterprise"],
      allowedByokProviders: [],
      allowedEnterpriseProviders: ["bedrock"],
    },
    features: { agentEnabled: true, webSearchEnabled: true },
    sharing: { externalLinkSharing: "allowed" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: true,
    },
    minAppVersion: null,
  },
});

test("unmanaged policy needs no transcription step (openwhispr allowed)", async () => {
  const { getEnterpriseTranscriptionNeed } = await load();
  assert.equal(
    getEnterpriseTranscriptionNeed(
      { status: "unmanaged", policy: null, appVersion: null },
      PROVIDERS
    ),
    "none"
  );
  assert.equal(
    getEnterpriseTranscriptionNeed({ status: "idle", policy: null, appVersion: null }, PROVIDERS),
    "none"
  );
});

test("openwhispr allowed wins even when other modes are allowed too", async () => {
  const { getEnterpriseTranscriptionNeed } = await load();
  const policy = managedPolicy({
    allowedModes: ["openwhispr", "providers", "local"],
    allowedByokProviders: ["groq"],
  });
  assert.equal(getEnterpriseTranscriptionNeed(policy, PROVIDERS), "none");
});

test("providers beats local when both are allowed and a provider survives the filter", async () => {
  const { getEnterpriseTranscriptionNeed } = await load();
  const policy = managedPolicy({
    allowedModes: ["providers", "local"],
    allowedByokProviders: ["groq"],
  });
  assert.equal(getEnterpriseTranscriptionNeed(policy, PROVIDERS), "byok");
});

test("providers mode with an empty provider allowlist falls through to local", async () => {
  const { getEnterpriseTranscriptionNeed } = await load();
  const policy = managedPolicy({
    allowedModes: ["providers", "local"],
    allowedByokProviders: [],
  });
  assert.equal(getEnterpriseTranscriptionNeed(policy, PROVIDERS), "local");
});

test("local only", async () => {
  const { getEnterpriseTranscriptionNeed } = await load();
  const policy = managedPolicy({ allowedModes: ["local"], allowedByokProviders: [] });
  assert.equal(getEnterpriseTranscriptionNeed(policy, PROVIDERS), "local");
});

test("self-hosted requires the custom provider to be allowed", async () => {
  const { getEnterpriseTranscriptionNeed } = await load();
  const allowed = managedPolicy({
    allowedModes: ["self-hosted"],
    allowedByokProviders: ["custom"],
  });
  assert.equal(getEnterpriseTranscriptionNeed(allowed, PROVIDERS), "self-hosted");

  // The self-hosted form is the "custom" provider variant of the byok step; a
  // policy that allows the mode but not the provider renders it unusable.
  const blocked = managedPolicy({ allowedModes: ["self-hosted"], allowedByokProviders: [] });
  assert.equal(getEnterpriseTranscriptionNeed(blocked, PROVIDERS), "unavailable");
});

test("nothing usable is distinct from OpenWhispr cloud being allowed", async () => {
  const { getEnterpriseTranscriptionNeed } = await load();
  const policy = managedPolicy({ allowedModes: [], allowedByokProviders: [] });
  assert.equal(getEnterpriseTranscriptionNeed(policy, PROVIDERS), "unavailable");
});
