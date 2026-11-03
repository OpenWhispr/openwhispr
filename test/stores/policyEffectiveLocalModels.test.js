const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { managedPolicy } = require("../helpers/harness/policyFixtures");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

const LLM_MODEL = "qwen3.5-0.8b-q4_k_m";
const PARAKEET = "parakeet-tdt-0.6b-v3";

const snapshot = ({ speech = null, llm = null, speechModes, llmModes } = {}) => ({
  status: "managed",
  appVersion: "1.11.1",
  policy: {
    ...managedPolicy({
      transcription: {
        allowedModes: speechModes ?? ["local", "openwhispr"],
        allowedLocalModels: speech,
      },
      llm: { allowedModes: llmModes ?? ["local", "openwhispr"], allowedLocalModels: llm },
    }),
    features: { agentEnabled: true, webSearchEnabled: false },
  },
});

async function loadStores(t, prefix) {
  const vite = await createRendererServer(t, { cachePrefix: `ow-policy-effective-${prefix}-` });
  return {
    ...(await vite.ssrLoadModule("/stores/settingsStore.ts")),
    ...(await vite.ssrLoadModule("/stores/policyRules.ts")),
    INFERENCE_SCOPES: (await vite.ssrLoadModule("/config/inferenceScopes.ts")).INFERENCE_SCOPES,
    vite,
  };
}

const localContexts = (raw, overrides = {}) => ({
  ...raw,
  transcriptionMode: "local",
  useLocalWhisper: true,
  localTranscriptionProvider: "whisper",
  whisperModel: "base",
  parakeetModel: PARAKEET,
  cohereModel: "",
  meetingTranscriptionMode: "local",
  meetingUseLocalWhisper: true,
  meetingLocalTranscriptionProvider: "whisper",
  meetingWhisperModel: "",
  meetingParakeetModel: "",
  meetingCohereModel: "",
  uploadTranscriptionMode: "local",
  uploadUseLocalWhisper: true,
  uploadLocalTranscriptionProvider: "whisper",
  uploadWhisperModel: "",
  uploadParakeetModel: "",
  uploadCohereModel: "",
  ...overrides,
});

// What the three transcription contexts can run: the model each resolves to, and
// whether the policy would let it start.
function contextVerdicts(stores, effective, state) {
  const { selectResolvedMeetingTranscription, selectResolvedUploadTranscription } = stores;
  const { getTranscriptionSelection, isTranscriptionContextAllowed } = stores;
  const resolved = {
    meeting: selectResolvedMeetingTranscription(effective),
    upload: selectResolvedUploadTranscription(effective),
  };
  return Object.fromEntries(
    ["dictation", "meeting", "upload"].map((context) => [
      context,
      {
        allowed: isTranscriptionContextAllowed(state, effective, context),
        model: getTranscriptionSelection(effective, context).model,
        blocked: !!effective.policyBlockedLocalScopes?.includes(context),
        ...(resolved[context]
          ? {
              resolved:
                resolved[context].localTranscriptionProvider === "whisper"
                  ? resolved[context].whisperModel
                  : resolved[context].parakeetModel,
            }
          : {}),
      },
    ])
  );
}

test("useShallow settles on the whole effective settings under a managed policy", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const stores = await loadStores(t, "shallow");
  const { useSettingsStore, selectPolicyEffectiveSettings, vite } = stores;
  const { useShallow } = await vite.ssrLoadModule("zustand/react/shallow");

  useSettingsStore.setState(localContexts(useSettingsStore.getState()));
  for (const [label, policyState, expectedBlocked] of [
    ["nothing blocked", snapshot(), []],
    ["something blocked", snapshot({ speech: ["small"] }), ["dictation", "meeting", "upload"]],
  ]) {
    await t.test(label, async () => {
      let renders = 0;
      let effective;
      function Harness() {
        renders += 1;
        effective = useSettingsStore(
          useShallow((settings) => selectPolicyEffectiveSettings(settings, policyState))
        );
        return null;
      }
      root = createRoot(container);
      await React.act(async () => root.render(React.createElement(Harness)));
      assert.ok(renders <= 2, `settled after ${renders} renders`);
      assert.deepEqual(
        effective.policyBlockedLocalScopes.filter((scope) =>
          ["dictation", "meeting", "upload"].includes(scope)
        ),
        expectedBlocked
      );
      await React.act(async () => root.unmount());
      root = null;
    });
  }

  await t.test("equal contents share one frozen value", () => {
    const raw = useSettingsStore.getState();
    for (const policyState of [snapshot(), snapshot({ speech: ["small"] })]) {
      const first = selectPolicyEffectiveSettings(raw, policyState).policyBlockedLocalScopes;
      const second = selectPolicyEffectiveSettings(raw, policyState).policyBlockedLocalScopes;
      assert.equal(first, second);
      assert.ok(Object.isFrozen(first));
    }
  });
});

test("a workspace with Local off moves members to an allowed mode, list or no list", async (t) => {
  installBrowserGlobals(t);
  const stores = await loadStores(t, "local-off");
  const { useSettingsStore, selectPolicyEffectiveSettings, selectResolvedLLMConfig } = stores;
  const { INFERENCE_SCOPES, reconcilePolicyModeSelection } = stores;
  const raw = localContexts(useSettingsStore.getState());
  for (const def of Object.values(INFERENCE_SCOPES)) {
    if (def.optional) continue;
    raw[def.storeKeys.mode] = "local";
    raw[def.storeKeys.provider] = "qwen";
    raw[def.storeKeys.model] = LLM_MODEL;
  }
  for (const [label, lists] of [
    ["no list", {}],
    ["a dormant list", { speech: ["base"], llm: [LLM_MODEL] }],
  ]) {
    await t.test(label, () => {
      const state = snapshot({ ...lists, speechModes: ["openwhispr"], llmModes: ["openwhispr"] });
      const effective = selectPolicyEffectiveSettings(raw, state);
      for (const mode of ["transcriptionMode", "meetingTranscriptionMode"]) {
        assert.equal(effective[mode], "openwhispr", mode);
      }
      assert.equal(effective.uploadTranscriptionMode, "openwhispr");
      assert.equal(effective.useLocalWhisper, false);
      assert.deepEqual(effective.policyBlockedLocalScopes, []);
      for (const scope of Object.keys(INFERENCE_SCOPES)) {
        if (INFERENCE_SCOPES[scope].optional) continue;
        assert.equal(selectResolvedLLMConfig(effective, scope).mode, "openwhispr", scope);
      }
      assert.equal(raw.transcriptionMode, "local", "the saved preference is untouched");

      // The Settings tiles highlight the same mode the runtime uses, so no tile is a dead end.
      const tiles = [{ id: "openwhispr" }, { id: "local" }, { id: "providers" }];
      assert.equal(
        reconcilePolicyModeSelection(tiles, "transcription", state, raw.transcriptionMode),
        effective.transcriptionMode
      );
      assert.equal(
        reconcilePolicyModeSelection(tiles, "llm", state, raw.cleanupMode),
        effective.cleanupMode
      );
    });
  }
});

test("Local allowed but this model not: inert blank, no mode switch; a clamp onto Local is judged too", async (t) => {
  installBrowserGlobals(t);
  const stores = await loadStores(t, "inert");
  const { useSettingsStore, selectPolicyEffectiveSettings, selectResolvedLLMConfig } = stores;
  const raw = localContexts(useSettingsStore.getState(), {
    cleanupMode: "local",
    cleanupProvider: "qwen",
    cleanupModel: LLM_MODEL,
  });
  const inert = selectPolicyEffectiveSettings(raw, snapshot({ speech: ["small"], llm: [] }));
  assert.equal(inert.transcriptionMode, "local");
  assert.equal(inert.whisperModel, "");
  assert.equal(selectResolvedLLMConfig(inert, "dictationCleanup").mode, "local");
  assert.equal(selectResolvedLLMConfig(inert, "dictationCleanup").model, "");

  // A member on Cloud in a workspace that now only allows Local: the mode moves, but
  // neither their saved model nor the catalog default may run unapproved.
  const cloudMember = {
    ...raw,
    transcriptionMode: "openwhispr",
    useLocalWhisper: false,
    cleanupMode: "openwhispr",
    cleanupProvider: "openwhispr",
    cleanupModel: "",
  };
  const clamped = selectPolicyEffectiveSettings(
    cloudMember,
    snapshot({ speech: ["small"], llm: [], speechModes: ["local"], llmModes: ["local"] })
  );
  assert.equal(clamped.transcriptionMode, "local");
  assert.ok(clamped.policyBlockedLocalScopes.includes("dictation"));
  assert.equal(clamped.whisperModel, "");
  assert.equal(selectResolvedLLMConfig(clamped, "dictationCleanup").mode, "local");
  assert.equal(selectResolvedLLMConfig(clamped, "dictationCleanup").model, "");
  assert.ok(clamped.policyBlockedLocalScopes.includes("dictationCleanup"));
});

test("each transcription context is judged against its own raw selection", async (t) => {
  installBrowserGlobals(t);
  const stores = await loadStores(t, "contexts");
  const { useSettingsStore, selectPolicyEffectiveSettings } = stores;
  const base = useSettingsStore.getState();
  const speech = (allowed) => snapshot({ speech: allowed });
  const verdict = (overrides, state) =>
    contextVerdicts(
      stores,
      selectPolicyEffectiveSettings(localContexts(base, overrides), state),
      state
    );

  await t.test("a blocked dictation leaves an approved inherited meeting and upload usable", () => {
    const state = speech(["base"]);
    const result = verdict({ localTranscriptionProvider: "nvidia" }, state);
    assert.deepEqual(result.dictation, { allowed: false, model: "", blocked: true });
    for (const context of ["meeting", "upload"]) {
      assert.deepEqual(
        result[context],
        { allowed: true, model: "base", blocked: false, resolved: "base" },
        context
      );
    }
  });

  await t.test("an inherited blocked value leaves every context that inherits it inert", () => {
    const result = verdict({}, speech(["small"]));
    for (const context of ["dictation", "meeting", "upload"]) {
      assert.equal(result[context].allowed, false, context);
      assert.equal(result[context].model, "", context);
      assert.equal(result[context].blocked, true, context);
    }
    assert.equal(result.meeting.resolved, "");
    assert.equal(result.upload.resolved, "");
  });

  await t.test("a fine dictation does not rescue a blocked meeting override", () => {
    const result = verdict({ meetingWhisperModel: "small" }, speech(["base"]));
    assert.equal(result.dictation.allowed, true);
    assert.equal(result.dictation.model, "base");
    assert.deepEqual(result.meeting, { allowed: false, model: "", blocked: true, resolved: "" });
    assert.deepEqual(result.upload, {
      allowed: true,
      model: "base",
      blocked: false,
      resolved: "base",
    });
  });

  await t.test("a blocked dictation does not take a context's own approved model", () => {
    const result = verdict(
      { whisperModel: "small", meetingWhisperModel: "base", uploadWhisperModel: "tiny" },
      speech(["base", "tiny"])
    );
    assert.equal(result.dictation.allowed, false);
    assert.deepEqual(result.meeting, {
      allowed: true,
      model: "base",
      blocked: false,
      resolved: "base",
    });
    assert.deepEqual(result.upload, {
      allowed: true,
      model: "tiny",
      blocked: false,
      resolved: "tiny",
    });
  });

  await t.test("a context on another engine inherits that engine's approved model", () => {
    const result = verdict(
      {
        localTranscriptionProvider: "whisper",
        whisperModel: "small",
        meetingLocalTranscriptionProvider: "nvidia",
      },
      speech([PARAKEET])
    );
    assert.equal(result.dictation.allowed, false);
    assert.deepEqual(result.meeting, {
      allowed: true,
      model: PARAKEET,
      blocked: false,
      resolved: PARAKEET,
    });
  });
});

test("guests and unmanaged users are never judged on the model id", async () => {
  const {
    isLocalModelAllowedByPolicy: allowed,
    isLlmSelectionAllowed,
    isTranscriptionSelectionAllowed,
  } = await import("../../src/stores/policyRules.ts");
  for (const status of ["idle", "unmanaged"]) {
    const state = { status, policy: null, appVersion: null };
    for (const scope of ["transcription", "llm"]) {
      for (const model of ["", " ", "not-a-model", "base", LLM_MODEL]) {
        assert.equal(allowed(state, scope, model), true, `${status} ${scope} ${model}`);
      }
    }
    assert.equal(isLlmSelectionAllowed(state, { mode: "local", provider: "local" }), true);
    assert.equal(isTranscriptionSelectionAllowed(state, { mode: "local", provider: "" }), true);
  }
  for (const status of ["loading", "error"]) {
    const state = { status, policy: null, appVersion: null };
    assert.equal(allowed(state, "transcription", "base"), false, status);
  }
  for (const model of ["", " ", "not-a-model"]) {
    assert.equal(allowed(snapshot(), "transcription", model), false, `managed "${model}"`);
  }
});

test("point-of-use refusals name a blocked model or Local-off and leave other refusals generic", async () => {
  const { localChoiceRefusal, transcriptionChoiceRefusal } =
    await import("../../src/stores/policyRules.ts");
  const settings = (overrides = {}) => ({
    transcriptionMode: "local",
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
    cloudTranscriptionProvider: "",
    ...overrides,
  });

  assert.deepEqual(
    transcriptionChoiceRefusal(snapshot({ speech: ["small"] }), settings(), "dictation"),
    {
      code: "POLICY_MODEL_BLOCKED",
      messageKey: "models.policy.modelBlocked",
      settingsTarget: "speechToText",
    }
  );
  assert.deepEqual(
    transcriptionChoiceRefusal(snapshot({ speechModes: ["openwhispr"] }), settings(), "dictation"),
    {
      code: "POLICY_LOCAL_MODE_BLOCKED",
      messageKey: "models.policy.modeBlocked",
      settingsTarget: "speechToText",
    }
  );
  assert.deepEqual(localChoiceRefusal(snapshot({ llm: [] }), "llm"), {
    code: "POLICY_MODEL_BLOCKED",
    messageKey: "models.policy.emptyIntersection",
    settingsTarget: "llms",
  });

  // Nothing to refuse, or a refusal another model wouldn't fix.
  assert.equal(transcriptionChoiceRefusal(snapshot(), settings(), "dictation"), null);
  assert.equal(
    transcriptionChoiceRefusal(
      snapshot({ speechModes: ["local"] }),
      settings({ transcriptionMode: "providers" }),
      "dictation"
    ),
    null
  );
  const offFeature = snapshot({ speech: ["small"] });
  offFeature.policy.features.audioUploadEnabled = false;
  assert.equal(transcriptionChoiceRefusal(offFeature, settings(), "upload"), null);
  const floor = snapshot({ speech: ["small"] });
  floor.policy.minAppVersion = "9.9.9";
  assert.equal(transcriptionChoiceRefusal(floor, settings(), "dictation"), null);
  for (const status of ["loading", "error", "idle", "unmanaged"]) {
    assert.equal(
      transcriptionChoiceRefusal(
        { status, policy: null, appVersion: null },
        settings(),
        "dictation"
      ),
      null
    );
  }
});

test("the recording and upload gates agree with the start: managed audio outranks a refused selection", async (t) => {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const stores = await loadStores(t, "hook");
  const { useSettingsStore, vite } = stores;
  const { useTranscriptionContextAllowed, useTranscriptionChoiceRefusal } =
    await vite.ssrLoadModule("/hooks/usePolicy.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { useWorkspaceStore } = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  useWorkspaceStore.setState({ activeWorkspaceId: "workspace-a" });
  useSettingsStore.setState(
    localContexts(useSettingsStore.getState(), {
      whisperModel: "small",
      enterpriseTranscriptionSetupMode: "auto",
    })
  );
  let seen;
  function Harness() {
    seen = {
      meeting: useTranscriptionContextAllowed("meeting"),
      upload: useTranscriptionContextAllowed("upload"),
      refusal: useTranscriptionChoiceRefusal("meeting"),
    };
    return null;
  }
  root = createRoot(container);
  const state = snapshot({ speech: ["base"], speechModes: ["local", "enterprise"] });
  state.policy.transcription.allowedEnterpriseProviders = ["azure"];
  usePolicyStore.setState({ ...state, accountId: "account-a", authGeneration: 1 });
  await React.act(async () => root.render(React.createElement(Harness)));
  assert.deepEqual(seen, {
    meeting: false,
    upload: false,
    refusal: {
      code: "POLICY_MODEL_BLOCKED",
      messageKey: "models.policy.modelBlocked",
      settingsTarget: "speechToText",
    },
  });

  const deployment = { allowedDeployments: ["company"], defaultDeployment: "company" };
  await React.act(async () =>
    useEnterpriseIdentityStore.setState({
      accountId: "account-a",
      workspaceId: "workspace-a",
      authGeneration: 1,
      status: "ready",
      config: {
        generation: 1,
        providers: [
          {
            version: 1,
            provider: "azure",
            mode: "managed_required",
            allowManualSetup: false,
            config: {
              tenantId: "11111111-1111-4111-8111-111111111111",
              clientId: "22222222-2222-4222-8222-222222222222",
              endpoint: "https://company.openai.azure.com",
              apiVersion: "v1",
              transcription: deployment,
              realtime: deployment,
            },
          },
        ],
      },
    })
  );
  assert.equal(seen.meeting, true);
  assert.equal(seen.upload, true);
  await React.act(async () => root.unmount());
  root = null;
});

test("a blank local AI model under a managed policy stays blank", async (t) => {
  installBrowserGlobals(t);
  const { useSettingsStore, selectPolicyEffectiveSettings, selectResolvedLLMConfig } =
    await loadStores(t, "blank-llm");
  const raw = {
    ...useSettingsStore.getState(),
    cleanupMode: "local",
    cleanupProvider: "qwen",
    cleanupModel: "",
  };

  const managed = selectPolicyEffectiveSettings(raw, snapshot({ llm: null }));
  assert.equal(selectResolvedLLMConfig(managed, "dictationCleanup").model, "");
  assert.ok(managed.policyBlockedLocalScopes.includes("dictationCleanup"));
});
