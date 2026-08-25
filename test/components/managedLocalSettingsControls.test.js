const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { click, findElements, installManagedLocalTestDom } = require("./managedLocalTestDom");

const translationMock = `const t = (key) => key; export const useTranslation = () => ({ t });`;
const managedSelectionMock = `export const useManagedLocalModelSelection = () => ({ provider: "whisper", model: "base" });`;

test("managed main transcription keeps preview and GPU controls beside the notice", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: { testManagedSelection: "true" },
    window: {
      electronAPI: {
        listGpus: async () => [
          { index: 0, uuid: "gpu-0", name: "First", vramMb: 8192 },
          { index: 1, uuid: "gpu-1", name: "Second", vramMb: 8192 },
        ],
        getGpuDeviceIndex: async () => "gpu-0",
      },
    },
  });
  const { container, createContainer } = installManagedLocalTestDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-main-controls-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": translationMock,
      "/i18n": `export const normalizeUiLanguage = (value) => value; export default { language: "en", changeLanguage: async () => {}, t: (key) => key, getFixedT: () => (key) => key };`,
      "/hooks/useManagedLocalModelSelection": `export const useManagedLocalModelSelection = () => localStorage.getItem("testManagedSelection") === "true" ? ({ provider: "whisper", model: "base" }) : undefined;`,
      TranscriptionModelPicker: `export default function Picker() { return null; }`,
      "/hooks/usePolicy": `export const usePolicySnapshot = () => ({}); export const usePolicyModeOptions = (modes, _kind, mode) => ({ modes, effectiveMode: mode, isModeAllowed: () => true });`,
      "/services/SyncService.js": `export const syncService = {};`,
      "/stores/noteStore.js": `export const startMigration = async () => {}; export const useMigration = () => ({});`,
      "/stores/policyStore": `export const usePolicyStore = () => ({});`,
      "/ui/ProviderIcon": `export const ProviderIcon = () => null;`,
      PromptStudio: `export default function PromptStudio() { return null; }`,
      providerIcons: `export const getProviderIcon = () => null; export const isMonochromeProvider = () => false;`,
    },
  });
  const { TranscriptionSection } = await vite.ssrLoadModule("/components/SettingsPage.tsx");
  const noop = () => {};
  const previewChanges = [];
  const sectionProps = {
    isSignedIn: true,
    startOnboarding: noop,
    cloudTranscriptionMode: "openwhispr",
    setCloudTranscriptionMode: noop,
    useLocalWhisper: false,
    setUseLocalWhisper: noop,
    updateTranscriptionSettings: noop,
    cloudTranscriptionProvider: "groq",
    setCloudTranscriptionProvider: noop,
    cloudTranscriptionModel: "",
    setCloudTranscriptionModel: noop,
    localTranscriptionProvider: "whisper",
    setLocalTranscriptionProvider: noop,
    whisperModel: "base",
    setWhisperModel: noop,
    parakeetModel: "",
    setParakeetModel: noop,
    setCloudTranscriptionBaseUrl: noop,
    transcriptionMode: "openwhispr",
    setTranscriptionMode: noop,
    remoteTranscriptionUrl: "",
    setRemoteTranscriptionUrl: noop,
    remoteTranscriptionModel: "",
    setRemoteTranscriptionModel: noop,
    showTranscriptionPreview: true,
    setShowTranscriptionPreview: (value) => previewChanges.push(value),
    toast: noop,
  };
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(TranscriptionSection, sectionProps));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.match(container.textContent, /managedLocalModels\.notice\.managedDescription/);
  assert.match(container.textContent, /settingsPage\.transcription\.transcriptionPreview/);
  assert.match(container.textContent, /settingsPage\.transcription\.gpuDevice\.title/);
  await React.act(async () => {
    const toggle = findElements(container, (element) => element.tagName === "BUTTON")[0];
    click(toggle);
  });
  assert.deepEqual(previewChanges, [false]);
  await React.act(async () => root.unmount());

  localStorage.removeItem("testManagedSelection");
  const personalContainer = createContainer();
  const personalRoot = createRoot(personalContainer);
  await React.act(async () => {
    personalRoot.render(React.createElement(TranscriptionSection, sectionProps));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.doesNotMatch(personalContainer.textContent, /managedLocalModels\.notice/);
  assert.doesNotMatch(
    personalContainer.textContent,
    /settingsPage\.transcription\.transcriptionPreview/
  );
  await React.act(async () => personalRoot.unmount());
});

test("managed meeting settings keep speaker detection beside the locked model notice", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-meeting-controls-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": translationMock,
      "lucide-react": `export const Cloud = () => null; export const Key = () => null; export const Cpu = () => null; export const Network = () => null; export const Lock = () => null;`,
      "/hooks/useManagedLocalModelSelection": managedSelectionMock,
      "/stores/settingsStore": `
        const state = { isSignedIn: true, meetingTranscriptionMode: "local", meetingLocalTranscriptionProvider: "whisper", meetingWhisperModel: "base", speakerDiarizationEnabled: true, setSpeakerDiarizationEnabled() {} };
        export const useSettingsStore = (selector) => selector ? selector(state) : state;
      `,
      "/hooks/usePolicy": `export const usePolicyModeOptions = (modes, _kind, mode) => ({ modes, effectiveMode: mode, isModeAllowed: () => true });`,
      "/hooks/useStartOnboarding": `export const useStartOnboarding = () => () => {};`,
      TranscriptionModelPicker: `export default function Picker() { return null; }`,
      "/ui/ProviderIcon": `export const ProviderIcon = () => null;`,
    },
  });
  const { MeetingTranscriptionPanel } = await vite.ssrLoadModule(
    "/components/settings/MeetingSettings.tsx"
  );
  const markup = renderToStaticMarkup(React.createElement(MeetingTranscriptionPanel));
  assert.match(markup, /managedLocalModels\.notice\.managedDescription/);
  assert.match(markup, /settings\.meeting\.speakerDetection\.title/);
});

test("managed LLM editors keep thinking controls for every affected settings path", async (t) => {
  installBrowserGlobals(t);
  const { container } = installManagedLocalTestDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-llm-controls-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": translationMock,
      "lucide-react": `export const Cloud = () => null; export const Key = () => null; export const Cpu = () => null; export const Network = () => null; export const Building2 = () => null; export const ShieldCheck = () => null; export const AlertTriangle = () => null; export const Lock = () => null;`,
      "/stores/settingsStore": `
        const config = { scope: "dictationCleanup", mode: "local", cloudMode: "byok", provider: "qwen", model: "assistant-model", disableThinking: false };
        const state = { isSignedIn: true, enterpriseSetupMode: "managed", setEnterpriseSetupMode() {} };
        export const LLM_ENTERPRISE_POLICY_PROVIDER_IDS = []; export const LLM_POLICY_PROVIDER_IDS = [];
        export const selectPolicyEffectiveSettings = (value) => value;
        export const selectManagedLocalEffectiveSettings = (value) => value;
        export const selectResolvedLLMConfig = () => config;
        export const setResolvedLLMConfig = () => {};
        export const useSettingsStore = (selector) => selector(state);
      `,
      "/hooks/usePolicy": `
        export const usePolicySnapshot = () => ({});
        export const usePolicyModeOptions = (modes) => ({ modes, effectiveMode: "local", isModeAllowed: () => true });
      `,
      "/models/ModelRegistry": `
        export const getLocalModel = () => ({ supportsThinking: true }); export const getCloudModel = () => null;
        export const isProviderValidForMode = () => true; export const enterpriseProviderName = (value) => value;
        export const modelRegistry = { getModel: () => ({ model: { name: "Assistant" } }) };
      `,
      ReasoningModelSelector: `export default function Selector() { return null; }`,
      EnterpriseSection: `export default function Enterprise() { return null; }`,
      OpenAICompatiblePanel: `export default function Panel() { return null; }`,
      TestConnectionButton: `export default function TestButton() { return null; }`,
      "/ui/ProviderIcon": `export const ProviderIcon = () => null;`,
    },
  });
  const [editorModule, identityModule, managedModule] = await Promise.all([
    vite.ssrLoadModule("/components/settings/InferenceConfigEditor.tsx"),
    vite.ssrLoadModule("/stores/enterpriseIdentityStore.ts"),
    vite.ssrLoadModule("/components/onboarding/managedLocalModels.ts"),
  ]);
  const InferenceConfigEditor = editorModule.default;
  identityModule.useEnterpriseIdentityStore.setState({
    accountId: "account-1",
    workspaceId: "workspace-1",
    authGeneration: 7,
    status: "ready",
    verdict: "configured",
    failClosed: false,
    error: null,
    config: {
      generation: 11,
      localModels: { selections: [{ provider: "qwen", model: "assistant-model" }] },
    },
  });
  const scopes = [
    "dictationCleanup",
    "dictationAgent",
    "dictationTranslation",
    "noteFormatting",
    "chatIntelligence",
  ];
  const editors = React.createElement(
    React.Fragment,
    null,
    ...scopes.map((scope) => React.createElement(InferenceConfigEditor, { key: scope, scope }))
  );
  const root = createRoot(container);
  await React.act(async () => root.render(editors));
  assert.equal(container.textContent.match(/managedLocalModels\.notice\.waiting/g)?.length, 5);
  await React.act(async () => {
    managedModule.rememberManagedLocalModelBinding({
      accountId: "account-1",
      workspaceId: "workspace-1",
      authGeneration: 7,
      configGeneration: 11,
      category: "assistant",
      provider: "qwen",
      model: "assistant-model",
    });
  });
  assert.equal(container.textContent.includes("managedLocalModels.notice.waiting"), false);
  assert.equal(container.textContent.match(/Assistant/g)?.length, 5);
  assert.equal(
    container.textContent.match(/managedLocalModels\.notice\.managedDescription/g)?.length,
    5
  );
  assert.equal(container.textContent.match(/reasoning\.disableThinking\.label/g)?.length, 5);
  await React.act(async () => root.unmount());
});
