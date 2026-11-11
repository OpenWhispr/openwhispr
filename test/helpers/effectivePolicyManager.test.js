const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const {
  defaultDevicePolicy,
  normalizeDeviceValues,
} = require("../../src/helpers/managedDevicePolicy");
const {
  createEffectivePolicyManager,
  mergePolicies,
  resolveEffectivePolicy,
  resolveUpdatePolicy,
} = require("../../src/helpers/effectivePolicyManager");
const { devicePolicyNetworkAllowed } = require("../../src/helpers/devicePolicyNetwork");
const { productOperationAllowed } = require("../../src/helpers/productPolicy");
const guest = { accountId: null, authGeneration: 0, authenticated: false };
const member = { accountId: "member", authGeneration: 1, authenticated: true };
const absentDevice = normalizeDeviceValues({});

// Every key path of OrgPolicy, read from the type itself.
function orgPolicyKeyPaths() {
  const file = path.join(__dirname, "../../src/types/policy.ts");
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const orgPolicy = source.statements.find(
    (statement) => ts.isInterfaceDeclaration(statement) && statement.name.text === "OrgPolicy"
  );
  const paths = [];
  const walk = (members, prefix) => {
    for (const member of members) {
      const key = [...prefix, member.name.text];
      paths.push(key);
      if (member.type && ts.isTypeLiteralNode(member.type)) walk(member.type.members, key);
    }
  };
  walk(orgPolicy.members, []);
  return paths;
}

test("merging keeps every OrgPolicy field", () => {
  const policy = JSON.parse(require("./fixtures/admin-mdm-device-values.json").Policy);
  policy.features.memoryEnabled = true;
  for (const key of orgPolicyKeyPaths())
    assert.ok(
      key.reduce((value, part) => value?.[part], policy) !== undefined,
      `the sample policy needs ${key.join(".")}`
    );
  assert.deepEqual(mergePolicies([policy, policy]), policy);
});

test("local model allow-lists intersect, and any non-automatic meeting start wins", () => {
  const device = defaultDevicePolicy();
  const workspace = defaultDevicePolicy();
  device.transcription.allowedLocalModels = ["base", "small"];
  workspace.transcription.allowedLocalModels = ["small", "turbo"];
  workspace.llm.allowedLocalModels = ["qwen"];
  workspace.meetings = { transcriptionStart: "manual" };
  const merged = mergePolicies([device, workspace]);
  assert.deepEqual(merged.transcription.allowedLocalModels, ["small"]);
  assert.deepEqual(merged.llm.allowedLocalModels, ["qwen"]);
  assert.equal(merged.meetings.transcriptionStart, "manual");
  assert.equal(mergePolicies([device]).llm.allowedLocalModels, null);
  assert.equal(mergePolicies([device]).meetings.transcriptionStart, "automatic");
});

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
      heldPolicy: () => {
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
    { deviceReady: true, deviceManaged: true, code: "DEVICE_POLICY_INVALID" },
    { deviceReady: true, deviceManaged: true, success: true, localOnly: true },
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
  const signIn = {
    deviceReady: true,
    deviceManaged: true,
    success: false,
    status: "error",
    code: "POLICY_SIGN_IN_REQUIRED",
  };
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
  const pending = {
    deviceReady: true,
    deviceManaged: true,
    success: false,
    status: "error",
    code: "POLICY_SIGN_IN_REQUIRED",
  };
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

test("the network guard enforces only a device policy, and not while a verdict loads", () => {
  const provider = "https://api.openai.com/v1/audio/transcriptions";
  const failed = resolveEffectivePolicy(absentDevice, { success: false, code: "X" }, member);
  const unresolvable = resolveEffectivePolicy(
    absentDevice,
    { success: false, code: "POLICY_UNRESOLVABLE" },
    member
  );
  const signInDevice = normalizeDeviceValues({ RequireSignIn: true });
  for (const snapshot of [
    failed,
    unresolvable,
    resolveEffectivePolicy(absentDevice, null, member),
    resolveEffectivePolicy(signInDevice, null, member),
  ])
    assert.equal(devicePolicyNetworkAllowed(snapshot, provider), true, snapshot.code);
  assert.equal(
    devicePolicyNetworkAllowed(
      resolveEffectivePolicy(signInDevice, { success: false, code: "X" }, member),
      provider
    ),
    false
  );
});

test("a failed lookup holds nothing closed without evidence that the identity is managed", () => {
  const channels = [
    ["transcribe-local-whisper"],
    ["transcribe-local-parakeet"],
    ["process-local-reasoning"],
    ["retry-transcription"],
    ["transcribe-audio-file"],
    ["cloud-transcribe"],
    ["proxy-xai-transcription"],
  ];
  const failed = resolveEffectivePolicy(
    absentDevice,
    { success: false, code: "POLICY_UNAVAILABLE", httpStatus: 401 },
    member
  );
  const loading = resolveEffectivePolicy(absentDevice, null, member);
  assert.equal(failed.success, true);
  assert.equal(failed.status, "unmanaged");
  assert.equal(loading.status, "loading");
  for (const [channel] of channels) {
    assert.equal(productOperationAllowed(failed, "1.11.1", channel), true, channel);
    assert.equal(productOperationAllowed(loading, "1.11.1", channel), true, channel);
  }
  for (const snapshot of [
    resolveEffectivePolicy(absentDevice, { success: false, code: "POLICY_UNRESOLVABLE" }, member),
    resolveEffectivePolicy(
      normalizeDeviceValues({ RequireSignIn: true }),
      { success: false, code: "POLICY_UNAVAILABLE" },
      member
    ),
    resolveEffectivePolicy({ status: "loading", managed: false }, null, member),
  ])
    for (const [channel] of channels)
      assert.equal(productOperationAllowed(snapshot, "1.11.1", channel), false, channel);
});

test("a device with only RequireSignIn leaves OpenRouter transcription allowed", () => {
  const snapshot = resolveEffectivePolicy(
    normalizeDeviceValues({ RequireSignIn: true }),
    { success: true, managed: false },
    member
  );
  assert.equal(
    productOperationAllowed(snapshot, "1.11.1", "batch-transcription", [
      { mode: "providers", provider: "openrouter" },
    ]),
    true
  );
});

test("updates follow the user's choice after a failed lookup, and ignore an unreadable device", () => {
  const failed = { success: false, code: "POLICY_UNAVAILABLE", httpStatus: 401 };
  const managed = defaultDevicePolicy();
  managed.updates.mode = "it_managed";
  const managedWorkspace = { success: true, managed: true, policy: managed };
  const invalid = { status: "invalid", managed: true, code: "DEVICE_POLICY_INVALID" };
  assert.equal(resolveUpdatePolicy(absentDevice, failed, member).success, true);
  assert.equal(resolveUpdatePolicy(absentDevice, failed, member).managed, false);
  assert.equal(
    resolveUpdatePolicy(absentDevice, { success: false, code: "POLICY_UNRESOLVABLE" }, member)
      .success,
    false
  );
  assert.equal(
    resolveUpdatePolicy(normalizeDeviceValues({ RequireSignIn: true }), failed, member).success,
    false
  );
  assert.equal(resolveUpdatePolicy(invalid, null, guest).success, true);
  assert.equal(resolveUpdatePolicy(invalid, null, member).success, true);
  assert.equal(
    resolveUpdatePolicy(invalid, managedWorkspace, member).policy.updates.mode,
    "it_managed"
  );
  assert.equal(resolveEffectivePolicy(invalid, managedWorkspace, member).success, false);
});

test("held lookups read no network, a failed lookup keeps the held verdict, and updates follow", async () => {
  let scope = member;
  const requests = [];
  const updates = [];
  let answer = { success: true, managed: false, accountId: "member", authGeneration: 1 };
  const manager = createEffectivePolicyManager({
    devicePolicy: { getSnapshot: () => absentDevice, subscribe: () => () => {} },
    workspacePolicyManager: {
      getPolicy: async (request) => {
        requests.push(["network", request]);
        return answer;
      },
      heldPolicy: (request) => {
        requests.push(["held", request]);
        return null;
      },
    },
    getScope: () => scope,
    broadcast: (_snapshot, updatePolicy) => updates.push(updatePolicy),
  });
  await manager.getPolicy({ accountId: "member", expectedAuthGeneration: 1, held: true });
  assert.deepEqual(requests, [["held", { accountId: "member", expectedAuthGeneration: 1 }]]);
  assert.equal(manager.getCurrent().status, "loading");
  await manager.getPolicy({ accountId: "member", expectedAuthGeneration: 1, refresh: true });
  assert.deepEqual(requests.at(-1), [
    "network",
    { accountId: "member", expectedAuthGeneration: 1, refresh: true },
  ]);
  assert.equal(manager.getCurrent().status, "unmanaged");
  answer = {
    success: false,
    code: "AUTH_CONTEXT_UNVALIDATED",
    accountId: "member",
    authGeneration: 1,
  };
  await manager.getPolicy({ accountId: "member", expectedAuthGeneration: 1 });
  assert.equal(manager.getCurrent().status, "unmanaged");
  assert.equal(manager.getUpdatePolicy().success, true);
  assert.equal(updates.at(-1).revision, manager.getCurrent().revision);
  scope = { ...member, authGeneration: 2 };
  manager.updateWorkspace({ ...answer, authGeneration: 2 });
  assert.equal(manager.getCurrent().status, "unmanaged");
  assert.equal(manager.getUpdatePolicy().status, "unmanaged");
  manager.stop();
});

test("a later failure doesn't lift a policy the server called unresolvable", () => {
  const manager = createEffectivePolicyManager({
    devicePolicy: { getSnapshot: () => absentDevice, subscribe: () => () => {} },
    workspacePolicyManager: {},
    getScope: () => member,
  });
  const identity = { accountId: "member", authGeneration: 1 };
  manager.updateWorkspace({ ...identity, success: false, code: "POLICY_UNRESOLVABLE" });
  manager.updateWorkspace({ ...identity, success: false, code: "AUTH_CONTEXT_UNVALIDATED" });
  assert.equal(manager.getCurrent().code, "POLICY_UNRESOLVABLE");
  assert.equal(manager.getCurrent().managed, true);
  manager.stop();
});

test("an identity with no verdict yet answers from what it last had while the network refreshes it", async () => {
  const { deferred } = require("./harness/deferred");
  const network = deferred();
  const manager = createEffectivePolicyManager({
    devicePolicy: { getSnapshot: () => absentDevice, subscribe: () => () => {} },
    workspacePolicyManager: {
      heldPolicy: () => ({
        success: true,
        managed: true,
        policy: defaultDevicePolicy(),
        accountId: "member",
        authGeneration: 1,
      }),
      getPolicy: () => network.promise,
    },
    getScope: () => member,
  });
  const refreshing = manager.getPolicy({ accountId: "member", expectedAuthGeneration: 1 });
  assert.equal(manager.getCurrent().status, "managed");
  network.resolve({ success: true, managed: false, accountId: "member", authGeneration: 1 });
  assert.equal((await refreshing).status, "unmanaged");
  manager.stop();
});
