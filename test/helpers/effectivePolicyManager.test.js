const test = require("node:test");
const assert = require("node:assert/strict");
const {
  defaultDevicePolicy,
  normalizeDeviceValues,
} = require("../../src/helpers/managedDevicePolicy");
const {
  createEffectivePolicyManager,
  mergePolicies,
  resolveEffectivePolicy,
} = require("../../src/helpers/effectivePolicyManager");
const { devicePolicyNetworkAllowed } = require("../../src/helpers/devicePolicyNetwork");
const { productOperationAllowed } = require("../../src/helpers/productPolicy");
const guest = { accountId: null, authGeneration: 0, authenticated: false };

test("effective merge intersects permissions without granting disjoint modes", () => {
  const device = defaultDevicePolicy();
  const workspace = defaultDevicePolicy();
  device.transcription.allowedModes = ["local"];
  workspace.transcription.allowedModes = ["providers"];
  assert.deepEqual(mergePolicies([device, workspace]).transcription.allowedModes, []);
  workspace.transcription.allowedModes = ["local"];
  device.transcription.allowedByokProviders = [];
  device.features.meetingRecordingEnabled = false;
  device.dataRetention.audioRetentionMaxDays = 7;
  workspace.dataRetention.localHistoryMode = "always_off";
  device.requiredLocalModels = ["tiny"];
  workspace.requiredLocalModels = ["base"];
  workspace.updates.mode = "it_managed";
  device.updates.mode = "always_on";
  const result = mergePolicies([device, workspace]);
  assert.deepEqual(result.transcription.allowedByokProviders, []);
  assert.equal(result.features.meetingRecordingEnabled, false);
  assert.equal(result.dataRetention.audioRetentionMaxDays, 7);
  assert.equal(result.dataRetention.localHistoryMode, "always_off");
  assert.deepEqual(result.requiredLocalModels, ["base", "tiny"]);
  assert.equal(result.updates.mode, "it_managed");
});

test("an empty LLM scope leaves permitted transcription and update policy available", () => {
  const policy = defaultDevicePolicy();
  policy.llm.allowedModes = [];
  policy.updates.mode = "always_on";
  const snapshot = resolveEffectivePolicy(
    normalizeDeviceValues({}),
    { success: true, managed: true, policy },
    { accountId: "member", authGeneration: 1, authenticated: true }
  );
  assert.equal(snapshot.success, true);
  assert.equal(productOperationAllowed(snapshot, "1.11.1", "transcribe-local-whisper"), true);
  assert.equal(productOperationAllowed(snapshot, "1.11.1", "process-local-reasoning"), false);
  assert.equal(productOperationAllowed(snapshot, "1.11.1", "cloud-reason"), false);
  assert.equal(snapshot.policy.updates.mode, "always_on");
});

test("local-only filtering preserves independent transcription and updates", () => {
  const policy = defaultDevicePolicy();
  policy.transcription.allowedModes = ["local"];
  policy.llm.allowedModes = ["providers"];
  policy.llm.allowedByokProviders = ["openai"];
  policy.updates.mode = "always_on";
  const device = normalizeDeviceValues({
    Policy: JSON.stringify(policy),
    RequireSignIn: false,
  });
  const snapshot = resolveEffectivePolicy(device, null, guest);
  assert.equal(snapshot.success, true);
  assert.deepEqual(snapshot.policy.llm.allowedModes, []);
  assert.equal(productOperationAllowed(snapshot, "1.11.1", "transcribe-local-whisper"), true);
  assert.equal(productOperationAllowed(snapshot, "1.11.1", "process-local-reasoning"), false);
  assert.equal(productOperationAllowed(snapshot, "1.11.1", "cloud-reason"), false);
  assert.equal(snapshot.policy.updates.mode, "always_on");
});

test("device-only guests are managed; required sign-in and invalid policies deny actions", () => {
  const valid = normalizeDeviceValues({
    Policy: JSON.stringify(defaultDevicePolicy()),
    RequireSignIn: false,
  });
  const result = resolveEffectivePolicy(valid, null, guest);
  assert.equal(result.managed, true);
  assert.deepEqual(result.policy.transcription.allowedModes, ["local"]);
  assert.equal(result.policy.features.webSearchEnabled, false);
  assert.equal(result.policy.features.connectorsEnabled, false);
  assert.equal(result.policy.dataRetention.cloudBackupAllowed, false);
  assert.equal(
    resolveEffectivePolicy({ ...valid, requireSignIn: true, localOnly: false }, null, guest).code,
    "POLICY_SIGN_IN_REQUIRED"
  );
  assert.equal(
    resolveEffectivePolicy(
      { status: "invalid", managed: true },
      { success: true, managed: true, policy: defaultDevicePolicy() },
      guest
    ).code,
    "DEVICE_POLICY_INVALID"
  );
});

test("local-only remains enforced with credentials and uses cached workspace policy only", async () => {
  const device = normalizeDeviceValues({ RequireSignIn: false });
  let scope = { accountId: "member", authGeneration: 1, authenticated: true };
  let calls = 0;
  const broadcasts = [];
  const manager = createEffectivePolicyManager({
    devicePolicy: { getSnapshot: () => device, subscribe: () => () => {} },
    workspacePolicyManager: {
      getPolicy: async () => {
        throw new Error("Network lookup must not run");
      },
      getCachedPolicy: () => {
        calls += 1;
        return { success: true, managed: false, accountId: "member", authGeneration: 1 };
      },
    },
    getScope: () => scope,
    broadcast: (value) => broadcasts.push(value),
  });
  const result = await manager.getPolicy({ accountId: "member", expectedAuthGeneration: 1 });
  assert.equal(calls, 1);
  assert.equal(result.localOnly, true);
  assert.deepEqual(result.policy.llm.allowedModes, ["local"]);
  scope = { ...guest, authGeneration: 2 };
  const signedOut = manager.invalidate();
  assert.equal(signedOut.managed, true);
  assert.equal(signedOut.localOnly, true);
  manager.updateWorkspace({
    success: true,
    managed: true,
    accountId: "member",
    authGeneration: 1,
    policy: defaultDevicePolicy(),
  });
  assert.equal(manager.getCurrent().accountId, null);
  assert.ok(signedOut.revision > result.revision);
  assert.ok(broadcasts.length >= 2);
  manager.stop();
});

test("network boundary blocks direct renderer, public, WebSocket and credentialed product requests", () => {
  for (const snapshot of [
    { deviceReady: false },
    { deviceReady: true, code: "DEVICE_POLICY_INVALID" },
    { deviceReady: true, success: true, localOnly: true },
  ]) {
    assert.equal(
      devicePolicyNetworkAllowed(snapshot, "https://api.openai.com/v1/responses"),
      false
    );
    assert.equal(devicePolicyNetworkAllowed(snapshot, "wss://api.deepgram.com/listen"), false);
    assert.equal(
      devicePolicyNetworkAllowed(snapshot, "http://127.0.0.1:8080/v1/chat/completions"),
      true
    );
  }
  const signIn = { deviceReady: true, success: false, code: "POLICY_SIGN_IN_REQUIRED" };
  assert.equal(
    devicePolicyNetworkAllowed(signIn, "https://auth.example/api/auth/get-session", [
      "https://auth.example",
    ]),
    true
  );
  assert.equal(
    devicePolicyNetworkAllowed(signIn, "https://other.example/api/auth/get-session", [
      "https://auth.example",
    ]),
    false
  );
  assert.equal(
    devicePolicyNetworkAllowed(signIn, "https://api.example/api/reason", ["https://api.example"]),
    false
  );
});

test("required sign-in permits email discovery only on configured control origins", () => {
  const pending = { deviceReady: true, success: false, code: "POLICY_SIGN_IN_REQUIRED" };
  const origins = ["https://auth.example"];
  assert.equal(
    devicePolicyNetworkAllowed(pending, "https://auth.example/api/check-user", origins),
    true
  );
  assert.equal(
    devicePolicyNetworkAllowed(pending, "https://other.example/api/check-user", origins),
    false
  );
  assert.equal(
    devicePolicyNetworkAllowed(pending, "https://auth.example/api/reason", origins),
    false
  );
  for (const denied of [
    { ...pending, localOnly: true },
    { ...pending, code: "DEVICE_POLICY_INVALID" },
    { ...pending, deviceReady: false },
  ]) {
    assert.equal(
      devicePolicyNetworkAllowed(denied, "https://auth.example/api/check-user", origins),
      false
    );
  }
});
