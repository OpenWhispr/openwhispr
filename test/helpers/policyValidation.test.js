const test = require("node:test");
const assert = require("node:assert/strict");

const { isValidPolicyShape } = require("../../src/helpers/policyValidation");

const validPolicy = () => ({
  version: 1,
  transcription: {
    allowedModes: ["openwhispr", "local"],
    allowedByokProviders: [],
  },
  llm: {
    allowedModes: ["openwhispr"],
    allowedByokProviders: ["openai"],
    allowedEnterpriseProviders: ["bedrock"],
  },
  features: { agentEnabled: true, webSearchEnabled: false },
  sharing: { externalLinkSharing: "allowed" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: true,
  },
  minAppVersion: null,
});

test("accepts a well-formed policy", () => {
  assert.equal(isValidPolicyShape(validPolicy()), true);
});

test("accepts special providers from the API policy contract", () => {
  const policy = validPolicy();
  policy.transcription.allowedByokProviders = ["custom"];
  policy.llm.allowedByokProviders = ["custom", "openrouter"];

  assert.equal(isValidPolicyShape(policy), true);
});

test("ignores stale additive analytics metadata", () => {
  const policy = validPolicy();
  policy.analytics = {
    enabled: false,
    provider: "legacy-server-field",
  };

  assert.equal(isValidPolicyShape(policy), true);
});

test("requires the supported policy schema version", () => {
  for (const version of [undefined, null, 0, 2, "1"]) {
    const policy = validPolicy();
    policy.version = version;
    assert.equal(isValidPolicyShape(policy), false, String(version));
  }
});

test("accepts empty allowlists", () => {
  const policy = validPolicy();
  policy.transcription.allowedModes = [];
  policy.llm.allowedModes = [];
  policy.llm.allowedEnterpriseProviders = [];
  assert.equal(isValidPolicyShape(policy), true);
});

test("rejects unknown modes and providers", () => {
  const cases = [
    [
      "transcription.allowedModes",
      (policy) => policy.transcription.allowedModes.push("enterprise"),
    ],
    ["llm.allowedModes", (policy) => policy.llm.allowedModes.push("future-mode")],
    [
      "transcription.allowedByokProviders",
      (policy) => policy.transcription.allowedByokProviders.push("future-stt"),
    ],
    ["llm.allowedByokProviders", (policy) => policy.llm.allowedByokProviders.push("future-llm")],
    [
      "llm.allowedEnterpriseProviders",
      (policy) => policy.llm.allowedEnterpriseProviders.push("future-enterprise"),
    ],
  ];

  for (const [label, mutate] of cases) {
    const policy = validPolicy();
    mutate(policy);
    assert.equal(isValidPolicyShape(policy), false, label);
  }
});

test("rejects a missing or non-object policy", () => {
  assert.equal(isValidPolicyShape(undefined), false);
  assert.equal(isValidPolicyShape(null), false);
  assert.equal(isValidPolicyShape("managed"), false);
  assert.equal(isValidPolicyShape(42), false);
});

test("rejects a policy missing a scope", () => {
  for (const scope of ["transcription", "llm"]) {
    const policy = validPolicy();
    delete policy[scope];
    assert.equal(isValidPolicyShape(policy), false, `missing ${scope}`);
  }
});

test("rejects non-array allowlists the renderer dereferences", () => {
  for (const [scope, field] of [
    ["transcription", "allowedModes"],
    ["transcription", "allowedByokProviders"],
    ["llm", "allowedModes"],
    ["llm", "allowedByokProviders"],
    ["llm", "allowedEnterpriseProviders"],
  ]) {
    const policy = validPolicy();
    policy[scope][field] = "openwhispr";
    assert.equal(isValidPolicyShape(policy), false, `${scope}.${field} as string`);
    delete policy[scope][field];
    assert.equal(isValidPolicyShape(policy), false, `${scope}.${field} missing`);
  }
});

test("rejects missing or mistyped feature flags", () => {
  for (const field of ["agentEnabled", "webSearchEnabled"]) {
    const policy = validPolicy();
    policy.features[field] = "true";
    assert.equal(isValidPolicyShape(policy), false, `features.${field} as string`);
    delete policy.features[field];
    assert.equal(isValidPolicyShape(policy), false, `features.${field} missing`);
  }
  const policy = validPolicy();
  delete policy.features;
  assert.equal(isValidPolicyShape(policy), false, "features missing");
});

test("rejects unknown sharing and local-history modes", () => {
  const badSharing = validPolicy();
  badSharing.sharing.externalLinkSharing = "everyone";
  assert.equal(isValidPolicyShape(badSharing), false);

  const noSharing = validPolicy();
  delete noSharing.sharing;
  assert.equal(isValidPolicyShape(noSharing), false);

  const badHistory = validPolicy();
  badHistory.dataRetention.localHistoryMode = "sometimes";
  assert.equal(isValidPolicyShape(badHistory), false);
});

test("rejects mistyped retention fields", () => {
  const badBackup = validPolicy();
  badBackup.dataRetention.cloudBackupAllowed = "no";
  assert.equal(isValidPolicyShape(badBackup), false);

  const badDays = validPolicy();
  badDays.dataRetention.audioRetentionMaxDays = "30";
  assert.equal(isValidPolicyShape(badDays), false);

  const cappedDays = validPolicy();
  cappedDays.dataRetention.audioRetentionMaxDays = 30;
  assert.equal(isValidPolicyShape(cappedDays), true);

  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const policy = validPolicy();
    policy.dataRetention.audioRetentionMaxDays = value;
    assert.equal(isValidPolicyShape(policy), false, String(value));
  }
});

test("accepts null or canonical minAppVersion, rejects malformed versions", () => {
  const versioned = validPolicy();
  versioned.minAppVersion = "1.8.0";
  assert.equal(isValidPolicyShape(versioned), true);

  const badVersion = validPolicy();
  badVersion.minAppVersion = 1.8;
  assert.equal(isValidPolicyShape(badVersion), false);

  for (const value of ["1.8", "01.8.1", "1.8.1-beta.1", "required"]) {
    const policy = validPolicy();
    policy.minAppVersion = value;
    assert.equal(isValidPolicyShape(policy), false, value);
  }

  const noVersion = validPolicy();
  delete noVersion.minAppVersion;
  assert.equal(isValidPolicyShape(noVersion), false);
});
