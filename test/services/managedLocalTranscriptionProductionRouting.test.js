const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const identity = { accountId: "account-a", workspaceId: "workspace-a", authGeneration: 4 };
const selection = { provider: "nvidia", modelId: "nvidia-parakeet-tdt-0.6b-v3" };
const localModels = {
  version: 9,
  updatedAt: new Date(0).toISOString(),
  updatedByUserId: null,
  transcription: [selection],
  reasoning: [],
};

function managedBindingStorage() {
  return {
    enterpriseManagedLocalModelBindingsV1: JSON.stringify({
      "account-a:workspace-a": {
        configVersion: 9,
        transcription: selection,
        reasoning: null,
        error: null,
      },
    }),
  };
}

function setManagedRuntime(useEnterpriseIdentityStore, usePolicyStore) {
  useEnterpriseIdentityStore.setState({
    ...identity,
    status: "ready",
    config: { generation: 5, localModels },
    lastKnownLocalModels: localModels,
    lastKnownLocalModelsKnown: true,
    failClosed: false,
  });
  usePolicyStore.setState({
    status: "unmanaged",
    appVersion: "1.8.4",
    policy: null,
  });
}

function staleCloudFileConfig() {
  return {
    useLocalWhisper: false,
    localTranscriptionProvider: "whisper",
    whisperModel: "tiny",
    parakeetModel: "stale-parakeet",
    isOpenWhisprCloud: true,
    getApiKey: () => "stale-key",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionBaseUrl: "https://api.openai.example.test/v1",
    cloudTranscriptionModel: "gpt-4o-transcribe",
    language: "en",
    transcriptionMode: "openwhispr",
  };
}

test("file upload sends the exact managed local provider and model despite stale cloud settings", async (t) => {
  const localCalls = [];
  let cloudCalls = 0;
  installBrowserGlobals(t, {
    initialStorage: managedBindingStorage(),
    window: {
      electronAPI: {
        transcribeAudioFile: async (filePath, options) => {
          localCalls.push({ filePath, options });
          return { success: true, text: "managed local" };
        },
        transcribeAudioFileCloud: async () => {
          cloudCalls += 1;
          return { success: true, text: "stale cloud" };
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-upload-production-routing-",
    mockModules: {
      "/lib/auth": "export const withSessionRefresh = (callback) => callback();",
    },
  });
  const { transcribeFile } = await vite.ssrLoadModule("/services/fileTranscription.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  setManagedRuntime(useEnterpriseIdentityStore, usePolicyStore);

  const result = await transcribeFile("/tmp/managed-upload.webm", staleCloudFileConfig(), false, {
    requestId: "upload-request-1",
  });

  assert.equal(result.text, "managed local");
  assert.equal(cloudCalls, 0);
  assert.deepEqual(localCalls, [
    {
      filePath: "/tmp/managed-upload.webm",
      options: {
        provider: "nvidia",
        model: selection.modelId,
        requestId: "upload-request-1",
      },
    },
  ]);
});

test("meeting prepare and start send the exact managed local provider and model", async (t) => {
  const preparedOptions = [];
  const startedOptions = [];
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const micStream = { getTracks: () => [] };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => micStream,
      },
    },
  });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });

  installBrowserGlobals(t, {
    initialStorage: managedBindingStorage(),
    window: {
      electronAPI: {
        meetingTranscriptionPrepare: async (options) => {
          preparedOptions.push(options);
          return { success: true };
        },
        meetingTranscriptionStart: async (options) => {
          startedOptions.push(options);
          return { success: false, error: "stop after routing assertion" };
        },
        checkSystemAudioAccess: async () => ({
          granted: false,
          status: "unsupported",
          mode: "unsupported",
          supportsPersistentGrant: false,
          supportsPersistentPortalGrant: false,
          supportsNativeCapture: false,
          supportsOnboardingGrant: false,
          requiresRuntimeSharePrompt: false,
          strategy: "unsupported",
          restoreTokenAvailable: false,
          portalVersion: null,
        }),
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-meeting-production-routing-",
  });
  const meeting = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  setManagedRuntime(useEnterpriseIdentityStore, usePolicyStore);
  useSettingsStore.setState({
    preferredLanguage: "en-US",
    customDictionary: [],
    meetingTranscriptionMode: "providers",
    meetingUseLocalWhisper: false,
    meetingLocalTranscriptionProvider: "whisper",
    meetingWhisperModel: "tiny",
    meetingParakeetModel: "stale-parakeet",
    meetingCloudTranscriptionProvider: "openai",
    meetingCloudTranscriptionModel: "gpt-4o-transcribe",
  });

  await meeting.prepareTranscription();
  assert.equal(
    await meeting.startRecording({
      noteId: 41,
      noteTitle: "Managed meeting",
      folderId: 7,
      autoEndEligible: false,
    }),
    true
  );

  assert.deepEqual(preparedOptions, [
    {
      provider: "local",
      localProvider: "nvidia",
      localModel: selection.modelId,
      language: "en",
    },
  ]);
  assert.equal(startedOptions.length, 1);
  assert.deepEqual(
    {
      provider: startedOptions[0].provider,
      localProvider: startedOptions[0].localProvider,
      localModel: startedOptions[0].localModel,
      language: startedOptions[0].language,
      noteId: startedOptions[0].noteId,
      autoEndEligible: startedOptions[0].autoEndEligible,
    },
    {
      provider: "local",
      localProvider: "nvidia",
      localModel: selection.modelId,
      language: "en",
      noteId: 41,
      autoEndEligible: false,
    }
  );
  assert.equal(typeof startedOptions[0].sessionId, "string");
  assert.notEqual(startedOptions[0].sessionId, "");
});
