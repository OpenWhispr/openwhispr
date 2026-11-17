const test = require("node:test");
const assert = require("node:assert/strict");
const { managedPolicy } = require("./harness/policyFixtures");
const { isValidPolicyShape } = require("../../src/helpers/policyValidation");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const speechId = "base";
const llmId = "qwen3.5-0.8b-q4_k_m";
const snapshot = (transcription = null, llm = null) => ({
  status: "managed",
  appVersion: "1.11.1",
  policy: managedPolicy({
    transcription: { allowedModes: ["local", "openwhispr"], allowedLocalModels: transcription },
    llm: { allowedModes: ["local", "openwhispr"], allowedLocalModels: llm },
  }),
});

test("local model policy fields validate shape without rejecting future IDs or empty intersections", () => {
  for (const scope of ["transcription", "llm"]) {
    for (const value of [undefined, null, [], ["future-id"]]) {
      const { policy } = snapshot();
      policy[scope].allowedLocalModels = value;
      assert.equal(isValidPolicyShape(policy), true);
    }
    for (const value of [false, "base", [""], [1], {}]) {
      const { policy } = snapshot();
      policy[scope].allowedLocalModels = value;
      assert.equal(isValidPolicyShape(policy), false);
    }
  }
});

test("local model decisions combine scope catalog, status, mode, version and nullable approvals", async () => {
  const {
    isLocalModelAllowedByPolicy: allowed,
    allowedLocalModelIds,
    filterLocalModelOptionsByPolicy,
  } = await import("../../src/stores/policyRules.ts");
  for (const [scope, id, wrongId] of [
    ["transcription", speechId, llmId],
    ["llm", llmId, speechId],
  ]) {
    for (const status of ["idle", "unmanaged", "loading", "error"]) {
      assert.equal(
        allowed({ status, policy: null, appVersion: null }, scope, id),
        ["idle", "unmanaged"].includes(status)
      );
    }
    for (const list of [null, [id], [], ["future-id"]]) {
      const state = snapshot();
      state.policy[scope].allowedLocalModels = list;
      assert.equal(allowed(state, scope, id), list === null || list.includes(id));
      for (const invalid of ["", " ", wrongId, "unknown"])
        assert.equal(allowed(state, scope, invalid), false);
    }
    const state = snapshot();
    assert.equal(allowed(state, scope, id), true);
    state.policy.minAppVersion = "1.11.2";
    assert.equal(allowed(state, scope, id), false);
    state.policy.minAppVersion = null;
    state.policy[scope].allowedModes = ["openwhispr"];
    assert.equal(allowed(state, scope, id), false);
  }
  assert.deepEqual(allowedLocalModelIds(snapshot(["future-id"]), "transcription"), []);
  assert.deepEqual(
    filterLocalModelOptionsByPolicy(
      [{ id: "base" }, { id: "small" }],
      "transcription",
      snapshot(["base"])
    ),
    [{ id: "base" }]
  );
});

test("required downloads are pruned by approvals and local mode; local selections require actual IDs", async () => {
  const { requiredLocalModelIds, isLlmSelectionAllowed, isTranscriptionSelectionAllowed } =
    await import("../../src/stores/policyRules.ts");
  const state = snapshot(["base"], [llmId]);
  state.policy.requiredLocalModels = ["base", "small", "future-id"];
  assert.deepEqual(requiredLocalModelIds(state), ["base"]);
  state.policy.transcription.allowedModes = ["openwhispr"];
  assert.deepEqual(requiredLocalModelIds(state), []);
  for (const decide of [isLlmSelectionAllowed, isTranscriptionSelectionAllowed]) {
    assert.equal(decide(snapshot(), { mode: "local", provider: "local" }), false);
    assert.equal(decide(snapshot(), { mode: "local", provider: "local", model: "" }), false);
  }
  assert.equal(
    isLlmSelectionAllowed(snapshot(), { mode: "local", provider: "local", model: llmId }),
    true
  );
  assert.equal(
    isTranscriptionSelectionAllowed(snapshot(), {
      mode: "local",
      provider: "whisper",
      model: "base",
    }),
    true
  );
});

test("blocked effective local selections stay inert across inheritance without altering preferences", async (t) => {
  const browser = installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "local-model-policy-settings-" });
  const {
    useSettingsStore,
    selectPolicyEffectiveSettings,
    selectResolvedLLMConfig,
    selectResolvedMeetingTranscription,
    selectResolvedUploadTranscription,
  } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { INFERENCE_SCOPES } = await vite.ssrLoadModule("/config/inferenceScopes.ts");
  const { getTranscriptionSelection, isTranscriptionContextAllowed } =
    await vite.ssrLoadModule("/stores/policyRules.ts");
  const raw = {
    ...useSettingsStore.getState(),
    transcriptionMode: "local",
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
    meetingTranscriptionMode: "local",
    meetingLocalTranscriptionProvider: "whisper",
    meetingWhisperModel: "small",
    uploadTranscriptionMode: "local",
    uploadLocalTranscriptionProvider: "whisper",
    uploadWhisperModel: "",
  };
  for (const def of Object.values(INFERENCE_SCOPES)) {
    raw[def.storeKeys.mode] = "local";
    raw[def.storeKeys.provider] = "qwen";
    raw[def.storeKeys.model] = llmId;
  }
  const before = JSON.stringify(raw);
  const state = snapshot(["base"], []);
  const effective = selectPolicyEffectiveSettings(raw, state);
  assert.equal(effective.meetingTranscriptionMode, "local");
  assert.equal(selectResolvedMeetingTranscription(effective).whisperModel, "");
  assert.equal(selectResolvedUploadTranscription(effective).whisperModel, "base");
  assert.equal(getTranscriptionSelection(effective, "meeting").model, "");
  assert.equal(getTranscriptionSelection(effective, "upload").model, "base");
  assert.equal(isTranscriptionContextAllowed(state, effective, "meeting"), false);
  for (const scope of Object.keys(INFERENCE_SCOPES)) {
    assert.equal(selectResolvedLLMConfig(effective, scope).mode, "local");
    assert.equal(selectResolvedLLMConfig(effective, scope).model, "", scope);
  }
  assert.equal(JSON.stringify(raw), before);
  assert.equal(
    selectResolvedMeetingTranscription(selectPolicyEffectiveSettings(raw, snapshot())).whisperModel,
    "small"
  );
  assert.ok(browser);
});

test("a refused model's row only names the organization for a refusal it made", async () => {
  const { localModelRowRefusal, localModelRefusal } =
    await import("../../src/stores/policyRules.ts");
  const managed = (transcription, minAppVersion = "1.0.0") => ({
    status: "managed",
    appVersion: "1.11.1",
    policy: {
      ...managedPolicy({ transcription: { allowedModes: ["local"], ...transcription } }),
      minAppVersion,
    },
  });

  assert.deepEqual(
    localModelRowRefusal(managed({ allowedLocalModels: ["base"] }), "transcription"),
    {
      labelKey: "models.policy.notApproved",
      hintKey: "models.policy.modelBlocked",
    }
  );
  assert.deepEqual(localModelRowRefusal(managed({ allowedLocalModels: [] }), "transcription"), {
    labelKey: "models.policy.notApproved",
    hintKey: "models.policy.emptyIntersection",
  });
  assert.deepEqual(
    localModelRowRefusal(managed({ allowedLocalModels: ["future-id"] }), "transcription"),
    { labelKey: "models.policy.notApproved", hintKey: "models.policy.noneSupported" }
  );
  assert.deepEqual(
    localModelRowRefusal({ status: "error", policy: null, appVersion: null }, "transcription"),
    { labelKey: "models.policy.unavailable", hintKey: "models.policy.unresolved" }
  );
  assert.deepEqual(
    localModelRowRefusal(managed({ allowedLocalModels: null }, "9.9.9"), "transcription"),
    { labelKey: "models.policy.updateRequired", hintKey: "models.policy.versionBlocked" }
  );
  assert.equal(
    localModelRefusal(managed({ allowedLocalModels: [] }), "transcription").code,
    "POLICY_MODEL_BLOCKED"
  );
});

test("only a settled verdict denies an audio feature; an unresolved one stops nothing", async () => {
  const { isAudioFeatureAllowed, isAudioFeatureDenied } =
    await import("../../src/stores/policyRules.ts");
  const managed = (features, minAppVersion = "1.0.0") => ({
    status: "managed",
    appVersion: "1.11.1",
    policy: { ...managedPolicy({}), minAppVersion, features },
  });

  for (const unresolved of [
    { status: "error", policy: null, appVersion: null },
    { status: "loading", policy: null, appVersion: null },
    { status: "idle", policy: null, appVersion: null },
    { status: "unmanaged", policy: null, appVersion: null },
  ]) {
    assert.equal(isAudioFeatureDenied(unresolved, "meeting"), false, unresolved.status);
    assert.equal(isAudioFeatureDenied(unresolved, "upload"), false, unresolved.status);
  }
  assert.equal(
    isAudioFeatureAllowed({ status: "error", policy: null, appVersion: null }, "meeting"),
    false,
    "new work still waits for a verdict"
  );
  assert.equal(isAudioFeatureDenied(managed({ meetingRecordingEnabled: false }), "meeting"), true);
  assert.equal(isAudioFeatureDenied(managed({ audioUploadEnabled: false }), "meeting"), false);
  assert.equal(isAudioFeatureDenied(managed({ audioUploadEnabled: false }), "upload"), true);
  assert.equal(isAudioFeatureDenied(managed({}, "9.9.9"), "meeting"), true);
});
