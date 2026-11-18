const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRendererServer,
  installBrowserGlobals,
  installMicCaptureGlobals,
} = require("../lib/rendererTestHarness");

const START_ARGS = {
  noteId: null,
  noteTitle: null,
  folderId: null,
  autoEndEligible: false,
  diarizationEnabled: false,
};
const AZURE = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  clientId: "22222222-2222-4222-8222-222222222222",
  endpoint: "https://company.openai.azure.com",
  apiVersion: "v1",
  transcription: { allowedDeployments: ["company-stt"], defaultDeployment: "company-stt" },
};

async function setup(t) {
  const calls = { prepare: [], start: [], access: 0, mic: 0 };
  const noop = () => () => {};
  installMicCaptureGlobals(t);
  const acquire = navigator.mediaDevices.getUserMedia;
  navigator.mediaDevices.getUserMedia = async (...args) => {
    calls.mic += 1;
    return acquire(...args);
  };
  installBrowserGlobals(t, {
    window: {
      setTimeout,
      electronAPI: {
        checkSystemAudioAccess: async () => {
          calls.access += 1;
          return { mode: "unsupported", strategy: "unsupported", status: "unsupported" };
        },
        meetingTranscriptionPrepare: async (options) => {
          calls.prepare.push(options);
          return { success: false };
        },
        meetingTranscriptionStart: async (options) => {
          calls.start.push(options);
          return { success: false, error: "stopped by test" };
        },
        meetingTranscriptionStop: async () => ({ success: true }),
        onMeetingSystemAudioInterrupted: noop,
        onMeetingSystemAudioResumed: noop,
      },
    },
  });
  const vite = await createRendererServer(t, { cachePrefix: "ow-meeting-managed-route-" });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useWorkspaceStore } = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  t.after(() => store.stopRecording());
  usePolicyStore.setState({ status: "unmanaged", accountId: "account-a", authGeneration: 1 });
  useWorkspaceStore.setState({ activeWorkspaceId: "workspace-a" });
  useSettingsStore.setState({
    meetingFollowsTranscription: false,
    meetingTranscriptionMode: "local",
    meetingUseLocalWhisper: true,
    enterpriseTranscriptionSetupMode: "auto",
  });
  const useRecord = (record) =>
    useEnterpriseIdentityStore.setState({
      accountId: "account-a",
      workspaceId: "workspace-a",
      authGeneration: 1,
      status: "ready",
      config: { generation: 1, providers: [{ version: 1, ...record }] },
    });
  return { calls, store, useRecord, usePolicyStore, useSettingsStore };
}

test("required batch-only Azure audio keeps meetings on the user's own route", async (t) => {
  const { calls, store, useRecord } = await setup(t);
  for (const overrides of [
    { mode: "managed_required", allowManualSetup: true },
    { mode: "managed_default", allowManualSetup: false },
  ]) {
    useRecord({ provider: "azure", config: AZURE, ...overrides });
    await store.prepareTranscription();
    assert.equal(calls.prepare.at(-1)?.provider, "local");
    assert.equal(calls.prepare.at(-1).managedContext, undefined);
  }
});

test("an unavailable managed realtime route fails before any capture starts, with a translated reason", async (t) => {
  const { calls, store, useRecord } = await setup(t);
  useRecord({
    provider: "openai-compatible",
    mode: "managed_required",
    allowManualSetup: false,
    config: { realtime: { defaultDeployment: " " } },
  });
  assert.equal(await store.startRecording(START_ARGS), true);
  assert.deepEqual(
    { access: calls.access, mic: calls.mic, starts: calls.start.length },
    { access: 0, mic: 0, starts: 0 }
  );
  const state = store.useMeetingRecordingStore.getState();
  assert.equal(state.isRecording, false);
  assert.equal(state.error, "managedConfig:enterprise.audio.operationUnavailable");
});

// Managed audio outranks the personal selection, so a stale local meeting model
// that a restricted list blocks must not stop an enterprise recording.
const MANAGED_AZURE = {
  provider: "azure",
  mode: "managed_required",
  allowManualSetup: false,
  config: {
    ...AZURE,
    transcription: { ...AZURE.transcription },
    realtime: { allowedDeployments: ["company-rt"], defaultDeployment: "company-rt" },
  },
};
const managedSnapshot = (allowedModes, allowedLocalModels) => ({
  status: "managed",
  managed: true,
  appVersion: "1.11.1",
  policy: {
    version: 1,
    transcription: {
      allowedModes,
      allowedByokProviders: [],
      allowedEnterpriseProviders: ["azure"],
      allowedLocalModels,
    },
    llm: { allowedModes: [], allowedByokProviders: [], allowedEnterpriseProviders: [] },
    features: { agentEnabled: false, webSearchEnabled: false },
    sharing: { externalLinkSharing: "disabled" },
    dataRetention: {
      audioRetentionMaxDays: null,
      localHistoryMode: "user_choice",
      cloudBackupAllowed: false,
    },
    minAppVersion: null,
  },
});

for (const [label, allowedModes] of [
  ["enterprise-only workspace", ["enterprise"]],
  ["workspace allowing Local and Enterprise with a restricted list", ["local", "enterprise"]],
]) {
  test(`a stale local meeting selection doesn't refuse enterprise audio: ${label}`, async (t) => {
    const { calls, store, useRecord, usePolicyStore, useSettingsStore } = await setup(t);
    useSettingsStore.setState({
      meetingLocalTranscriptionProvider: "whisper",
      whisperModel: "small",
      meetingWhisperModel: "",
    });
    usePolicyStore.setState(managedSnapshot(allowedModes, ["base"]));
    useRecord(MANAGED_AZURE);

    await store.prepareTranscription();
    assert.equal(calls.prepare.at(-1)?.provider, "enterprise-realtime");
    assert.equal(calls.prepare.at(-1).managedContext.provider, "azure");

    assert.equal(await store.startRecording(START_ARGS), true);
    assert.equal(store.useMeetingRecordingStore.getState().error, "stopped by test");
    assert.equal(calls.start.at(-1)?.provider, "enterprise-realtime");
    assert.equal(calls.mic, 1, "isCurrentStart let the capture proceed");
  });
}

test("a blocked local meeting with no managed route is refused by name, and the org's switch outranks managed audio", async (t) => {
  const { calls, store, useRecord, usePolicyStore, useSettingsStore } = await setup(t);
  useSettingsStore.setState({
    meetingLocalTranscriptionProvider: "whisper",
    whisperModel: "small",
    meetingWhisperModel: "",
  });
  const restricted = managedSnapshot(["local"], ["base"]);
  usePolicyStore.setState(restricted);

  await store.prepareTranscription();
  assert.equal(calls.prepare.length, 0);
  assert.equal(await store.startRecording(START_ARGS), false);
  assert.equal(store.useMeetingRecordingStore.getState().error, "POLICY_MODEL_BLOCKED");
  assert.equal(calls.start.length, 0);

  useRecord(MANAGED_AZURE);
  usePolicyStore.setState({
    ...restricted,
    policy: {
      ...restricted.policy,
      transcription: { ...restricted.policy.transcription, allowedModes: ["local", "enterprise"] },
      features: { ...restricted.policy.features, meetingRecordingEnabled: false },
    },
  });
  await store.prepareTranscription();
  assert.equal(calls.prepare.length, 0);
  assert.equal(await store.startRecording(START_ARGS), false);
  assert.equal(
    store.useMeetingRecordingStore.getState().error,
    "POLICY_MEETING_RECORDING_DISABLED"
  );
  assert.equal(calls.start.length, 0);
});

test("a model revoked during a meeting start reaches main blank for it to refuse, not as a default", async (t) => {
  const { calls, store, usePolicyStore, useSettingsStore } = await setup(t);
  useSettingsStore.setState({
    meetingLocalTranscriptionProvider: "whisper",
    whisperModel: "small",
    meetingWhisperModel: "",
  });
  usePolicyStore.setState(managedSnapshot(["local"], ["small", "base"]));
  const { electronAPI } = globalThis.window;
  const { checkSystemAudioAccess } = electronAPI;
  electronAPI.checkSystemAudioAccess = () => {
    usePolicyStore.setState(managedSnapshot(["local"], ["base"]));
    return checkSystemAudioAccess();
  };

  assert.equal(await store.startRecording(START_ARGS), true);
  assert.equal(calls.start.at(-1)?.provider, "local");
  assert.equal(calls.start.at(-1).localModel, "");
});

test("main starts with the options resolved before capture, not a second resolve after it", () => {
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../../src/stores/meetingRecordingStore.ts"),
    "utf8"
  );
  const start = source.slice(source.indexOf("meetingTranscriptionStart?.({"));
  const call = start.slice(0, start.indexOf("});"));
  assert.match(call, /\.\.\.meetingTranscriptionOptions,/);
  assert.ok(
    source.indexOf("const meetingTranscriptionOptions =") <
      source.indexOf("prepareMeetingSystemAudioCapture(initialSystemAudioAccess,")
  );
});
