const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const {
  click,
  findElements,
  installManagedLocalTestDom,
} = require("../components/managedLocalTestDom");

const identity = {
  accountId: "account-a",
  workspaceId: "workspace-a",
  authGeneration: 7,
  configGeneration: 12,
};

const managedClaim = (provider, model) => ({
  ...identity,
  managed: true,
  provider,
  model,
});

const guestClaim = (provider, model) => ({
  accountId: null,
  workspaceId: null,
  authGeneration: null,
  configGeneration: null,
  managed: false,
  provider,
  model,
});

function fileConfig(overrides = {}) {
  return {
    isSignedIn: false,
    useLocalWhisper: false,
    localTranscriptionProvider: "whisper",
    whisperModel: "base",
    parakeetModel: "parakeet-tdt-0.6b-v3",
    isOpenWhisprCloud: false,
    getApiKey: () => "test-key",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionBaseUrl: "",
    cloudTranscriptionModel: "whisper-1",
    language: "en",
    transcriptionMode: "providers",
    remoteTranscriptionUrl: "",
    remoteTranscriptionModel: "",
    ...overrides,
  };
}

async function installManagedRuntime(vite, selection) {
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { rememberManagedLocalModelBinding } = await vite.ssrLoadModule(
    "/components/onboarding/managedLocalModels.ts"
  );
  useEnterpriseIdentityStore.setState({
    accountId: identity.accountId,
    workspaceId: identity.workspaceId,
    authGeneration: identity.authGeneration,
    status: "ready",
    verdict: "configured",
    failClosed: false,
    config: {
      workspaceId: identity.workspaceId,
      version: 12,
      generation: identity.configGeneration,
      identity: {},
      providers: [],
      localModels: { selections: [selection] },
    },
  });
  rememberManagedLocalModelBinding({
    ...identity,
    category: "dictation",
    ...selection,
  });
}

async function flush() {
  await React.act(async () => new Promise((resolve) => setImmediate(resolve)));
}

async function waitForQueueSettled(store, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = store.getState();
    if (
      !state.isProcessing &&
      state.queue.every((item) => ["done", "error"].includes(item.status))
    ) {
      return state.queue;
    }
    if (Date.now() > deadline)
      throw new Error(`queue never settled: ${JSON.stringify(state.queue)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("file, URL, batch-upload, and voice-draft starts carry the literal effective route", async (t) => {
  const calls = [];
  const { window } = installBrowserGlobals(t, {
    window: {
      electronAPI: {
        authorizeTranscriptionStart: async (...args) => {
          calls.push(["admission", ...args]);
          return { success: true };
        },
        transcribeAudioFile: async (...args) => {
          calls.push(["local", ...args]);
          return { success: true, text: "local" };
        },
        transcribeAudioFileCloud: async (...args) => {
          calls.push(["cloud", ...args]);
          return { success: true, text: "cloud" };
        },
        transcribeAudioFileByok: async (...args) => {
          calls.push(["byok", ...args]);
          return { success: true, text: "byok" };
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-task5-file-routing-",
    mockModules: {
      "/lib/auth": "export const withSessionRefresh = (callback) => callback();",
    },
  });
  const { transcribeFile } = await vite.ssrLoadModule("/services/fileTranscription.ts");

  const guestRows = [
    {
      name: "personal local",
      config: fileConfig({ useLocalWhisper: true }),
      diarize: false,
      want: [
        "local",
        "/tmp/personal-local.webm",
        { provider: "whisper", model: "base", requestId: "personal-local" },
        guestClaim("whisper", "base"),
      ],
    },
    {
      name: "OpenWhispr cloud",
      config: fileConfig({ isOpenWhisprCloud: true }),
      diarize: false,
      want: [
        "cloud",
        "/tmp/openwhispr-cloud.webm",
        { requestId: "openwhispr-cloud" },
        guestClaim("openwhispr", null),
      ],
    },
    {
      name: "self-hosted",
      config: fileConfig({
        transcriptionMode: "self-hosted",
        remoteTranscriptionUrl: "https://stt.internal.example.com/v1",
        remoteTranscriptionModel: "private-whisper",
      }),
      diarize: false,
      wantClaim: guestClaim("self-hosted", "private-whisper"),
    },
    {
      name: "Tinfoil fixed batch model",
      config: fileConfig({
        cloudTranscriptionProvider: "tinfoil",
        cloudTranscriptionModel: "voxtral-mini-4b-realtime",
      }),
      diarize: false,
      wantClaim: guestClaim("tinfoil", "voxtral-small-24b"),
    },
    {
      name: "diarization does not replace the transcription model",
      config: fileConfig({ cloudTranscriptionModel: "whisper-1" }),
      diarize: true,
      wantClaim: guestClaim("openai", "whisper-1"),
    },
  ];

  for (const row of guestRows) {
    calls.length = 0;
    const requestId = row.name.toLowerCase().replaceAll(" ", "-");
    const filePath = `/tmp/${requestId}.webm`;
    await transcribeFile(filePath, row.config, row.diarize, { requestId });
    if (row.want) {
      assert.deepEqual(calls, [row.want], row.name);
    } else {
      assert.equal(calls.length, 1, row.name);
      assert.equal(calls[0][0], "byok", row.name);
      assert.equal(calls[0][1].diarize, row.diarize || undefined, row.name);
      assert.deepEqual(calls[0][2], row.wantClaim, row.name);
    }
  }

  await installManagedRuntime(vite, {
    provider: "nvidia",
    model: "parakeet-tdt-0.6b-v3",
  });
  calls.length = 0;
  await transcribeFile(
    "/tmp/managed-upload.webm",
    fileConfig({
      isSignedIn: true,
      isOpenWhisprCloud: true,
      cloudTranscriptionModel: "stale-cloud-model",
    }),
    false,
    { requestId: "managed-upload" }
  );
  assert.deepEqual(calls, [
    [
      "local",
      "/tmp/managed-upload.webm",
      {
        provider: "nvidia",
        model: "parakeet-tdt-0.6b-v3",
        requestId: "managed-upload",
      },
      managedClaim("nvidia", "parakeet-tdt-0.6b-v3"),
    ],
  ]);

  assert.ok(window.electronAPI.transcribeAudioFile, "production bridge remains installed");
});

test("a denied managed file start begins no diarization or fallback dispatch", async (t) => {
  const admissions = [];
  const starts = [];
  const diarizationDispatches = [];
  const networkDispatches = [];
  let authorizeStart = async () => ({
    success: false,
    error: "Managed enterprise configuration changed. Retry the request.",
    code: "MANAGED_CONFIG_CHANGED",
  });
  let transcribeLocal = async () => ({ success: true, text: "unexpected" });
  let diarizeLocal = async () => ({ success: true, segments: [] });
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        authorizeTranscriptionStart: async (...args) => {
          admissions.push(args);
          return authorizeStart();
        },
        transcribeAudioFile: async (...args) => {
          starts.push(args);
          return transcribeLocal();
        },
        diarizeAudioFile: async (...args) => {
          diarizationDispatches.push(args);
          return diarizeLocal();
        },
        transcribeAudioFileCloud: async (...args) => {
          networkDispatches.push(["cloud", ...args]);
          return { success: true, text: "unexpected" };
        },
        transcribeAudioFileByok: async (...args) => {
          networkDispatches.push(["byok", ...args]);
          return { success: true, text: "unexpected" };
        },
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-task5-denied-file-diarization-",
    mockModules: {
      "/lib/auth": "export const withSessionRefresh = (callback) => callback();",
    },
  });
  await installManagedRuntime(vite, { provider: "whisper", model: "small" });
  const { transcribeFileWithSpeakers } = await vite.ssrLoadModule("/services/fileTranscription.ts");

  const result = await transcribeFileWithSpeakers(
    "/tmp/denied-managed.webm",
    fileConfig({ isSignedIn: true }),
    { enabled: true, localModelsReady: true, numSpeakers: 2 },
    null,
    { requestId: "denied-managed" }
  );

  assert.equal(result.success, false);
  assert.equal(result.code, "MANAGED_CONFIG_CHANGED");
  assert.deepEqual(admissions, [
    [{ provider: "whisper", model: "small" }, managedClaim("whisper", "small")],
  ]);
  assert.deepEqual(starts, []);
  assert.deepEqual(diarizationDispatches, []);
  assert.deepEqual(networkDispatches, []);

  let finishTranscription;
  let finishDiarization;
  authorizeStart = async () => ({ success: true });
  transcribeLocal = () =>
    new Promise((resolve) => {
      finishTranscription = resolve;
    });
  diarizeLocal = () =>
    new Promise((resolve) => {
      finishDiarization = resolve;
    });
  const allowed = transcribeFileWithSpeakers(
    "/tmp/allowed-managed.webm",
    fileConfig({ isSignedIn: true }),
    { enabled: true, localModelsReady: true, numSpeakers: 2 },
    null,
    { requestId: "allowed-managed" }
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(admissions[1], [
    { provider: "whisper", model: "small" },
    managedClaim("whisper", "small"),
  ]);
  assert.equal(starts.length, 1, "transcription starts after literal admission success");
  assert.equal(diarizationDispatches.length, 1, "diarization starts after admission success");
  finishTranscription({ success: true, text: "allowed" });
  finishDiarization({ success: true, segments: [] });
  assert.deepEqual(await allowed, {
    success: true,
    text: "allowed",
    durationSeconds: null,
  });
});

test("the actual batch queue preserves signed-in route config at the shared boundary", async (t) => {
  const { window } = installBrowserGlobals(t);
  globalThis.__task5BatchCalls = [];
  t.after(() => delete globalThis.__task5BatchCalls);
  Object.assign(window.electronAPI, {
    saveNote: async () => ({ success: true, note: { id: 17 } }),
    deleteTempFile() {},
    cancelUrlDownload() {},
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-task5-batch-caller-",
    mockModules: {
      "/lib/auth": "export const withSessionRefresh = (callback) => callback();",
      "./settingsStore": "export const getSettings = () => ({});",
      "./policyStore": "export const usePolicyStore = { getState: () => ({}) };",
      "./policyRules": "export const isTranscriptionContextAllowed = () => true;",
      "/services/fileTranscription": `
        export const transcribeFileWithSpeakers = async (...args) => {
          globalThis.__task5BatchCalls.push(args);
          return { success: true, text: "queued transcript" };
        };
      `,
    },
  });
  const store = await vite.ssrLoadModule("/stores/batchQueueStore.ts");
  store.addFiles([{ name: "batch.webm", path: "/tmp/batch.webm", sizeBytes: 128 }]);
  store.processBatchQueue(
    {
      transcription: fileConfig({
        isSignedIn: true,
        useLocalWhisper: true,
        localTranscriptionProvider: "nvidia",
        parakeetModel: "parakeet-tdt-0.6b-v3",
      }),
      folderId: null,
    },
    { enabled: false, localModelsReady: false, numSpeakers: null }
  );

  const queue = await waitForQueueSettled(store.useBatchQueueStore);
  assert.equal(queue[0].status, "done");
  assert.equal(globalThis.__task5BatchCalls.length, 1);
  const [filePath, config, , , options] = globalThis.__task5BatchCalls[0];
  assert.equal(filePath, "/tmp/batch.webm");
  assert.equal(config.isSignedIn, true);
  assert.equal(config.useLocalWhisper, true);
  assert.equal(config.localTranscriptionProvider, "nvidia");
  assert.equal(config.parakeetModel, "parakeet-tdt-0.6b-v3");
  assert.equal(typeof options.requestId, "string");
});

test("the actual upload view passes its exact signed-in route config to the shared boundary", async (t) => {
  const { window } = installBrowserGlobals(t);
  const { container } = installManagedLocalTestDom(t);
  globalThis.__task5UploadSettings = {
    isSignedIn: true,
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    whisperModel: "base",
    parakeetModel: "parakeet-tdt-0.6b-v3",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionModel: "gpt-4o-mini-transcribe",
    cloudTranscriptionBaseUrl: "",
    cloudTranscriptionMode: "byok",
    transcriptionMode: "providers",
    remoteTranscriptionUrl: "",
    remoteTranscriptionModel: "",
    preferredLanguage: "en-US",
    useCleanupModel: false,
    cleanupModel: "",
    cortiEnvironment: "us",
    cortiTenant: "base",
    setUploadTranscriptionMode() {},
    setUploadCloudTranscriptionMode() {},
    setUploadUseLocalWhisper() {},
  };
  globalThis.__task5UploadCalls = [];
  t.after(() => {
    delete globalThis.__task5UploadSettings;
    delete globalThis.__task5UploadCalls;
  });
  Object.assign(window.electronAPI, {
    getDiarizationModelStatus: async () => ({ modelsDownloaded: true }),
    getSpaces: async () => [],
    getFolders: async () => [],
    selectAudioFile: async () => ({ canceled: false, filePaths: ["/tmp/upload.webm"] }),
    getFileSize: async () => 1024,
    listParakeetModels: async () => ({
      success: true,
      models: [{ model: "parakeet-tdt-0.6b-v3", downloaded: true }],
    }),
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-task5-upload-view-caller-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
          export const initReactI18next = { type: "3rdParty", init() {} };
          export const useTranslation = () => ({ t: (key) => key });
        `,
      "/hooks/useAuth": "export const useAuth = () => ({ isSignedIn: true });",
      "/hooks/useUsage": "export const useUsage = () => ({ hasPaidAccessOptimistic: true });",
      "/hooks/useSettings": "export const useSettings = () => globalThis.__task5UploadSettings;",
      "/hooks/useStartOnboarding": "export const useStartOnboarding = () => () => {};",
      "/hooks/usePolicy": `
        export const usePolicySnapshot = () => ({});
        export const useTranscriptionContextAllowed = () => true;
      `,
      "/stores/settingsStore": `
        const state = () => globalThis.__task5UploadSettings;
        export const getSettings = state;
        export const selectIsCloudCleanupMode = () => false;
        export const selectPolicyEffectiveSettings = (value) => value;
        export const selectResolvedUploadTranscription = (value) => value;
        export const useSettingsStore = (selector) => selector(state());
      `,
      "/stores/batchQueueStore": `
        export const useBatchQueue = () => ({
          queue: [], isProcessing: false, hasQueue: false,
          completedCount: 0, failedCount: 0, totalCount: 0,
          addFiles() {}, addUrls() {}, removeItem() {}, cancelAll() {}, clearQueue() {}, processQueue() {},
        });
      `,
      "/stores/policyStore": `
        export const usePolicyStore = () => true;
        usePolicyStore.getState = () => ({});
      `,
      "/stores/policyRules": "export const isTranscriptionContextAllowed = () => true;",
      "/ui/dialog": `
        import React from "react";
        export const Dialog = ({ open, children }) => open ? React.createElement(React.Fragment, null, children) : null;
        export const DialogContent = ({ children }) => React.createElement("section", null, children);
        export const DialogHeader = ({ children }) => React.createElement("header", null, children);
        export const DialogTitle = ({ children }) => React.createElement("h2", null, children);
        export const DialogFooter = ({ children }) => React.createElement("footer", null, children);
      `,
      "/services/fileTranscription": `
        export const shouldUseByokDiarize = () => false;
        export const getTranscriptionApiKey = () => "test-key";
        export const transcribeFileWithSpeakers = async (...args) => {
          globalThis.__task5UploadCalls.push(args);
          return { success: false, error: "stop after caller assertion" };
        };
      `,
      "/utils/generateTitle": "export const generateNoteTitle = async () => '';",
      "/components/notes/BatchQueueView":
        "export default function BatchQueueView() { return null; }",
    },
  });
  const UploadAudioView = (await vite.ssrLoadModule("/components/notes/UploadAudioView.tsx"))
    .default;
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(UploadAudioView)));
  await flush();

  const browse = findElements(
    container,
    (element) => element.tagName === "DIV" && element.getAttribute("role") === "button"
  )[0];
  assert.ok(
    browse,
    `actual upload view must render its browse action; rendered=${container.textContent}`
  );
  await React.act(async () => click(browse));
  await flush();
  const transcribe = findElements(
    container,
    (element) =>
      element.tagName === "BUTTON" &&
      ["notes.upload.transcribe", "Transcribe"].includes(element.textContent)
  )[0];
  assert.ok(transcribe, "actual upload view must render its selected-file start action");
  await React.act(async () => click(transcribe));
  await flush();

  assert.equal(globalThis.__task5UploadCalls.length, 1);
  const [filePath, config] = globalThis.__task5UploadCalls[0];
  assert.equal(filePath, "/tmp/upload.webm");
  assert.equal(config.isSignedIn, true);
  assert.equal(config.useLocalWhisper, true);
  assert.equal(config.localTranscriptionProvider, "nvidia");
  assert.equal(config.parakeetModel, "parakeet-tdt-0.6b-v3");
  await React.act(async () => root.unmount());
});

test("the actual voice-draft hook passes its exact signed-in route config to the shared boundary", async (t) => {
  const { window } = installBrowserGlobals(t);
  globalThis.__task5VoiceDraftSettings = {
    useLocalWhisper: true,
    localTranscriptionProvider: "whisper",
    whisperModel: "small",
    parakeetModel: "parakeet-tdt-0.6b-v3",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionBaseUrl: "",
    cloudTranscriptionModel: "gpt-4o-mini-transcribe",
    preferredLanguage: "en-US",
    transcriptionMode: "providers",
    remoteTranscriptionUrl: "",
    remoteTranscriptionModel: "",
    cortiEnvironment: "us",
    cortiTenant: "base",
  };
  globalThis.__task5VoiceDraftCalls = [];
  t.after(() => {
    delete globalThis.__task5VoiceDraftSettings;
    delete globalThis.__task5VoiceDraftCalls;
  });

  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalAudioContext = globalThis.AudioContext;
  const originalMediaRecorder = globalThis.MediaRecorder;
  const track = { stop() {} };
  const stream = { getTracks: () => [track] };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => stream } },
  });
  class FakeAudioContext {
    constructor() {
      this.destination = {};
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    createAnalyser() {
      return { fftSize: 0, connect() {} };
    }
    createGain() {
      return { gain: { value: 1 }, connect() {} };
    }
    close() {
      return Promise.resolve();
    }
  }
  class FakeMediaRecorder {
    constructor() {
      this.ondataavailable = null;
      this.onstop = null;
    }
    start() {}
    stop() {
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1])]) });
      this.onstop?.();
    }
  }
  globalThis.AudioContext = FakeAudioContext;
  globalThis.MediaRecorder = FakeMediaRecorder;
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
    if (originalAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = originalAudioContext;
    if (originalMediaRecorder === undefined) delete globalThis.MediaRecorder;
    else globalThis.MediaRecorder = originalMediaRecorder;
  });
  Object.assign(window.electronAPI, {
    saveTempAudio: async () => ({ path: "/tmp/voice-draft.webm" }),
    deleteTempAudio: async () => {},
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-task5-voice-draft-caller-",
    mockModules: {
      "/hooks/useAuth": "export const useAuth = () => ({ isSignedIn: true });",
      "/hooks/useSettings":
        "export const useSettings = () => globalThis.__task5VoiceDraftSettings;",
      "/stores/settingsStore": `
        export const useSettingsStore = (selector) => selector(globalThis.__task5VoiceDraftSettings);
      `,
      "/services/fileTranscription": `
        export const getTranscriptionApiKey = () => "test-key";
        export const transcribeFile = async (...args) => {
          globalThis.__task5VoiceDraftCalls.push(args);
          return { success: true, text: "voice transcript" };
        };
      `,
      "/utils/audioLevel": "export const analyserRms = () => 0;",
    },
  });
  const { useVoiceDraft } = await vite.ssrLoadModule("/components/chat/useVoiceDraft.ts");
  let draft;
  function Harness() {
    draft = useVoiceDraft({ onTranscript() {}, onError() {} });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  await draft.start();
  draft.stop();
  for (let i = 0; i < 50 && globalThis.__task5VoiceDraftCalls.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(globalThis.__task5VoiceDraftCalls.length, 1);
  const [filePath, config, diarize] = globalThis.__task5VoiceDraftCalls[0];
  assert.equal(filePath, "/tmp/voice-draft.webm");
  assert.equal(diarize, false);
  assert.equal(config.isSignedIn, true);
  assert.equal(config.localTranscriptionProvider, "whisper");
  assert.equal(config.whisperModel, "small");
});

test("the actual control-panel retry caller passes its exact managed claim", async (t) => {
  const calls = [];
  const updates = [];
  let retryResult = { success: false, error: "stop after caller assertion" };
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        retryTranscription: async (...args) => {
          calls.push(args);
          return retryResult;
        },
        updateTranscriptionText: async (...args) => {
          updates.push(args);
          return {
            success: true,
            transcription: { id: args[0], text: args[1], route_kind: "translation" },
          };
        },
      },
    },
  });
  globalThis.__task5ControlSettings = {
    isSignedIn: true,
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    parakeetModel: "parakeet-tdt-0.6b-v3",
    whisperModel: "base",
    cloudTranscriptionMode: "byok",
    cloudTranscriptionProvider: "openai",
    cloudTranscriptionModel: "gpt-4o-mini-transcribe",
    cloudTranscriptionBaseUrl: "",
    cortiEnvironment: "us",
    cortiTenant: "base",
    preferredLanguage: "en-US",
    transcriptionMode: "providers",
    remoteTranscriptionType: "openai",
    remoteTranscriptionUrl: "",
    remoteTranscriptionModel: "",
    useCleanupModel: true,
    setUseLocalWhisper() {},
    setCloudTranscriptionMode() {},
  };
  globalThis.__task5RetryCaller = null;
  globalThis.__task6ControlRoute = null;
  globalThis.__task6ControlReasoning = [];
  globalThis.__task6ControlReasoningCalls = [];
  globalThis.__task6ControlToasts = [];
  t.after(() => {
    delete globalThis.__task5ControlSettings;
    delete globalThis.__task5RetryCaller;
    delete globalThis.__task6ControlRoute;
    delete globalThis.__task6ControlReasoning;
    delete globalThis.__task6ControlReasoningCalls;
    delete globalThis.__task6ControlToasts;
  });
  const nullComponent = "export default function Component() { return null; }";
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-task5-control-retry-caller-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export const initReactI18next = { type: "3rdParty", init() {} };
        export const useTranslation = () => ({ t: (key) => key });
      `,
      "/hooks/useDialogs": `
        export const useDialogs = () => ({
          confirmDialog: { open: false }, alertDialog: { open: false },
          showConfirmDialog() {}, showAlertDialog() {}, hideConfirmDialog() {}, hideAlertDialog() {},
        });
      `,
      "/hooks/useHotkey": "export const useHotkey = () => ({ hotkey: '' });",
      "/ui/useToast": `
        export const useToast = () => ({
          toast(value) { globalThis.__task6ControlToasts.push(value); },
        });
      `,
      "/hooks/useUpdater": `
        export const useUpdater = () => ({
          status: { isDevelopment: true, updateAvailable: false, updateDownloaded: false },
          downloadProgress: 0, isDownloading: false, isInstalling: false,
          downloadUpdate: async () => {}, installUpdate: async () => {}, error: null,
        });
      `,
      "/hooks/useSettings": "export const useSettings = () => globalThis.__task5ControlSettings;",
      "/hooks/useAuth": `
        export const useAuth = () => ({ isSignedIn: true, isLoaded: true, user: { id: "user-a" } });
      `,
      "/hooks/useJoinableWorkspaces": `
        export const useJoinableWorkspaces = () => ({ joinable: null, dismiss() {}, markRequested() {} });
      `,
      "/hooks/useUsage": "export const useUsage = () => null;",
      "/lib/upsell": "export const decideUpsell = () => null;",
      "/hooks/useCollapsibleSidebar": `
        export const useCollapsibleSidebar = () => ({
          collapsed: false, peek: false, toggle() {}, showPeek() {}, hidePeek() {}, leaveToggle() {},
        });
      `,
      "/stores/transcriptionStore": `
        export const useTranscriptions = () => [];
        export const useShowDiscarded = () => false;
        export const initializeTranscriptions = async () => {};
        export const removeTranscription = () => {};
        export const updateTranscription = () => {};
        export const clearTranscriptions = () => {};
      `,
      "/stores/settingsStore": `
        const state = () => globalThis.__task5ControlSettings;
        export const getEffectiveCleanupModel = () => 'cleanup-model';
        export const getSettings = state;
        export const isCloudCleanupMode = () => false;
        export const selectPolicyEffectiveSettings = (value) => value;
        export const useSettingsStore = (selector) => selector(state());
        useSettingsStore.getState = state;
      `,
      "/stores/policyStore": `
        const state = {};
        export const usePolicyStore = (selector) => selector ? selector(state) : state;
        usePolicyStore.getState = () => state;
      `,
      "/hooks/usePolicy": "export const usePolicySnapshot = () => ({});",
      "/stores/policyRules": `
        export const isAgentAllowed = () => true;
        export const isControlPanelViewAllowed = () => true;
        export const isLlmSelectionAllowed = () => true;
        export const isPolicyActionAllowed = () => true;
        export const isTranscriptionContextAllowed = () => true;
        export const isUpdateRequiredByOrg = () => false;
      `,
      "/stores/meetingRecordingStore": `
        const state = { recordingNoteId: null, recordingFolderId: null };
        export const useIsMeetingMode = () => false;
        export const useIsNarrowWindow = () => false;
        export const useMeetingRecordingStore = (selector) => selector(state);
      `,
      "/stores/noteStore": `
        export const setActiveNoteId = () => {};
        export const setActiveFolderId = () => {};
        export const navigateToContainer = () => {};
        export const useActiveNoteId = () => null;
        export const initializeNotes = () => {};
      `,
      "/stores/streamingProvidersStore": "export const fetchProviders = () => {};",
      "/helpers/audioManager": `
        export const resolveReasoningRoute = () => globalThis.__task6ControlRoute;
      `,
      "/services/ReasoningService": `
        export default class ReasoningService {
          static async processText(...args) {
            globalThis.__task6ControlReasoningCalls.push(args);
            const next = globalThis.__task6ControlReasoning.shift();
            if (next instanceof Error) throw next;
            return next;
          }
        }
      `,
      "/utils/chineseScript": `
        export const applyChineseScript = async (text) => text;
        export const resolveChineseScriptTarget = () => null;
      `,
      "/utils/platform": "export const getCachedPlatform = () => 'linux';",
      "/utils/permissions": "export const isAccessibilitySkipped = () => false;",
      "/utils/gpuBannerPolicy":
        "export const eligibleGpuOffers = () => ({ transcription: false, intelligence: null });",
      "/services/SyncService.js": "export const syncService = { requestSyncAll() {} };",
      "/utils/logger": "export default { debug() {}, info() {}, warn() {}, error() {} };",
      "/utils/pendingInvitationToken": `
        export const consumePendingInvitationToken = () => null;
        export const clearPendingInvitationToken = () => {};
      `,
      "/HistoryView": `
        export default function HistoryView(props) {
          globalThis.__task5RetryCaller = props.onRetryTranscription;
          return null;
        }
      `,
      "/ControlPanelSidebar": nullComponent,
      "/MeetingRecordingMount": nullComponent,
      "/notes/MeetingRecordingPill": nullComponent,
      "/WindowControls": nullComponent,
      "/UpgradePrompt": nullComponent,
      "/PostMigrationOnboarding": nullComponent,
      "/notes/BackgroundActionToastListener": nullComponent,
      "/notes/SpaceSyncToastListener": nullComponent,
      "/AcceptInvitationModal": nullComponent,
      "/JoinYourTeamModal": nullComponent,
      "/ui/dialog": `
        export const ConfirmDialog = () => null;
        export const AlertDialog = () => null;
      `,
    },
  });
  await installManagedRuntime(vite, {
    provider: "nvidia",
    model: "parakeet-tdt-0.6b-v3",
  });
  const ControlPanel = (await vite.ssrLoadModule("/components/ControlPanel.tsx")).default;
  renderToStaticMarkup(React.createElement(ControlPanel));
  assert.equal(typeof globalThis.__task5RetryCaller, "function");

  await globalThis.__task5RetryCaller(41);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 41);
  assert.equal(calls[0][1].useLocalWhisper, true);
  assert.equal(calls[0][1].localTranscriptionProvider, "nvidia");
  assert.equal(calls[0][1].parakeetModel, "parakeet-tdt-0.6b-v3");
  assert.deepEqual(calls[0][2], managedClaim("nvidia", "parakeet-tdt-0.6b-v3"));

  const admissionError = (code) => Object.assign(new Error(code), { code });
  const translationRoute = (cleanupReachable = true) => ({
    kind: "translation",
    cleanupReachable,
    cleanupConfig: { inferenceScope: "dictationCleanup" },
    model: "translation-model",
    config: { inferenceScope: "dictationTranslation" },
  });
  const runRetry = async ({ routeKind, route, reasoning }) => {
    retryResult = {
      success: true,
      transcription: { id: 41, text: "raw", route_kind: routeKind },
    };
    globalThis.__task6ControlRoute = route;
    globalThis.__task6ControlReasoning = [...reasoning];
    globalThis.__task6ControlReasoningCalls.length = 0;
    globalThis.__task6ControlToasts.length = 0;
    updates.length = 0;
    await globalThis.__task5RetryCaller(41);
    return {
      reasoningCalls: globalThis.__task6ControlReasoningCalls.length,
      toastTitles: globalThis.__task6ControlToasts.map(({ title }) => title),
      updates: [...updates],
    };
  };

  await t.test("translation cleanup admission stops before translating raw text", async () => {
    assert.deepEqual(
      await runRetry({
        routeKind: "translation",
        route: translationRoute(),
        reasoning: [admissionError("MANAGED_CONFIG_UNAVAILABLE"), "translated"],
      }),
      {
        reasoningCalls: 1,
        toastTitles: ["controlPanel.history.retryError"],
        updates: [],
      }
    );
  });

  await t.test("translation admission from the translate step is terminal", async () => {
    assert.deepEqual(
      await runRetry({
        routeKind: "translation",
        route: translationRoute(false),
        reasoning: [admissionError("AUTHORIZATION_BOUNDARY_CHANGED")],
      }),
      {
        reasoningCalls: 1,
        toastTitles: ["controlPanel.history.retryError"],
        updates: [],
      }
    );
  });

  await t.test("ordinary cleanup admission is terminal", async () => {
    assert.deepEqual(
      await runRetry({
        routeKind: "cleanup",
        route: null,
        reasoning: [admissionError("PROVIDER_POLICY_CONFLICT")],
      }),
      {
        reasoningCalls: 1,
        toastTitles: ["controlPanel.history.retryError"],
        updates: [],
      }
    );
  });

  await t.test("ordinary translation cleanup failure still translates the raw text", async () => {
    const result = await runRetry({
      routeKind: "translation",
      route: translationRoute(),
      reasoning: [new Error("provider unavailable"), "translated"],
    });
    assert.equal(result.reasoningCalls, 2);
    assert.deepEqual(result.toastTitles, ["controlPanel.history.retrySuccess"]);
    assert.deepEqual(result.updates, [[41, "translated", "raw"]]);
  });

  await t.test("ordinary cleanup provider failure still retains the raw retry", async () => {
    assert.deepEqual(
      await runRetry({
        routeKind: "cleanup",
        route: null,
        reasoning: [new Error("provider unavailable")],
      }),
      {
        reasoningCalls: 1,
        toastTitles: ["controlPanel.history.retrySuccess"],
        updates: [],
      }
    );
  });
});

test("meeting prepare and start capture the same exact managed local route", async (t) => {
  const calls = [];
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const micStream = { getTracks: () => [] };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => micStream } },
  });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        meetingTranscriptionPrepare: async (...args) => {
          calls.push(["prepare", ...args]);
          return { success: true };
        },
        meetingTranscriptionStart: async (...args) => {
          calls.push(["start", ...args]);
          return { success: false, error: "stop after route assertion" };
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
    cachePrefix: "openwhispr-task5-meeting-routing-",
  });
  const meeting = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  await installManagedRuntime(vite, { provider: "whisper", model: "small" });
  useSettingsStore.setState({
    isSignedIn: true,
    preferredLanguage: "en-US",
    customDictionary: [],
    meetingTranscriptionMode: "providers",
    meetingUseLocalWhisper: false,
    meetingCloudTranscriptionProvider: "openai",
    meetingCloudTranscriptionModel: "gpt-4o-transcribe",
  });

  await meeting.prepareTranscription();
  await meeting.startRecording({
    noteId: 41,
    noteTitle: "Managed meeting",
    folderId: 7,
    autoEndEligible: false,
  });

  assert.equal(calls.length, 2);
  for (const [kind, options, claim] of calls) {
    assert.ok(kind === "prepare" || kind === "start");
    assert.equal(options.provider, "local");
    assert.equal(options.localProvider, "whisper");
    assert.equal(options.localModel, "small");
    assert.deepEqual(claim, managedClaim("whisper", "small"));
  }
});
