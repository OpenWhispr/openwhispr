const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

function elements(node, found = []) {
  if (Array.isArray(node)) node.forEach((child) => elements(child, found));
  else if (node?.props) {
    found.push(node);
    elements(node.props.children, found);
  }
  return found;
}

test("equal-generation workspace changes clear credentials and consent and ignore stale setup responses", async (t) => {
  let root;
  t.after(() => root && React.act(async () => root.unmount()));
  const pending = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        enterpriseAudioStatus: (input) =>
          new Promise((resolve) => pending.push({ input, resolve })),
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-audio-settings-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": "const t=(key)=>key; export function useTranslation(){return {t};}",
    },
  });
  const { useEnterpriseIdentityStore: store } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { EnterpriseAudioSettings } = await vite.ssrLoadModule(
    "/components/settings/EnterpriseAudioSettings.tsx"
  );
  const identity = (workspaceId) => ({
    accountId: "account-a",
    workspaceId,
    authGeneration: 1,
    config: {
      workspaceId,
      generation: 1,
      providers: [{ provider: "openai-compatible", version: 1, config: { batch: {} } }],
    },
  });
  store.setState(identity("workspace-a"));
  let tree;
  function Harness() {
    tree = EnterpriseAudioSettings();
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const find = (predicate) => elements(tree).find(predicate);
  const password = () => find((node) => node.props.type === "password");
  const consent = () => find((node) => node.props.ariaLabel === "enterprise.audio.probeConsent");
  const status = {
    success: true,
    slots: [{ slot: "http", present: false }],
    operations: ["batch"],
    configFingerprint: "a".repeat(64),
  };
  await React.act(async () => pending[0].resolve(status));
  await React.act(async () => {
    password().props.onChange({ target: { value: "workspace-a-test-secret" } });
    consent().props.onChange(true);
  });
  assert.equal(password().props.value, "workspace-a-test-secret");
  assert.equal(consent().props.checked, true);
  await React.act(async () => store.setState(identity("workspace-b")));
  assert.equal(consent().props.checked, false);
  assert.equal(password(), undefined);
  assert.equal(pending[1].input.context.workspaceId, "workspace-b");
  await React.act(async () => store.setState(identity("workspace-c")));
  await React.act(async () => pending[1].resolve(status));
  assert.equal(password(), undefined);
  await React.act(async () => pending[2].resolve(status));
  assert.equal(password().props.value, "");
  assert.equal(consent().props.checked, false);

  // A failed probe shows its translated reason, never the raw check code.
  globalThis.window.electronAPI.enterpriseAudioTest = async () => ({
    success: true,
    passed: false,
    code: "TIMEOUT",
    messageKey: "enterprise.audio.checks.timeout",
  });
  await React.act(async () => consent().props.onChange(true));
  await React.act(async () =>
    find((node) => node.props.children === "enterprise.audio.testBatch").props.onClick()
  );
  assert.equal(
    find((node) => node.props.role === "status").props.children,
    "enterprise.audio.checks.timeout"
  );
});

test("meeting and upload mode picks leave the shared enterprise setup mode to its explicit controls", async (t) => {
  let root;
  t.after(() => root && React.act(async () => root.unmount()));
  const meetings = [];
  const uploads = [];
  installBrowserGlobals(t, {
    initialStorage: { _providerSettingsMigrated: "1", uploadTranscriptionMigrated: "true" },
    window: {
      electronAPI: {
        meetingTranscriptionPrepare: async (options) => {
          meetings.push(options);
          return { success: false };
        },
        transcribeAudioFile: async (_path, options) => {
          uploads.push(options);
          return { success: true, text: "local" };
        },
        transcribeAudioFileByok: async (options) => {
          uploads.push(options);
          return { success: true, text: "managed" };
        },
      },
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-enterprise-audio-selection-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
      TranscriptionModelPicker: "export default function Picker() { return null; }",
    },
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useWorkspaceStore } = await vite.ssrLoadModule("/stores/workspaceStore.ts");
  const { getSettings, useSettingsStore, selectResolvedUploadTranscription } =
    await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { isManagedTranscriptionActive } = await vite.ssrLoadModule(
    "/services/managedTranscription.ts"
  );
  const { MeetingTranscriptionPanel } = await vite.ssrLoadModule(
    "/components/settings/MeetingSettings.tsx"
  );
  const { UploadTranscriptionPanel } = await vite.ssrLoadModule(
    "/components/settings/UploadSettings.tsx"
  );
  const { prepareTranscription } = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const { transcribeFile } = await vite.ssrLoadModule("/services/fileTranscription.ts");
  usePolicyStore.setState({ status: "unmanaged", accountId: "account-a", authGeneration: 1 });
  useWorkspaceStore.setState({ activeWorkspaceId: "workspace-a" });
  const record = {
    provider: "openai-compatible",
    mode: "managed_default",
    allowManualSetup: true,
    version: 1,
    config: {
      batch: { defaultDeployment: "company-batch" },
      realtime: { defaultDeployment: "company-realtime" },
    },
  };
  useEnterpriseIdentityStore.setState({
    status: "ready",
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    config: { generation: 1, providers: [record] },
  });
  let Panel;
  let tree;
  root = createRoot(container);
  function Harness() {
    tree = Panel();
    return null;
  }
  const selector = () => elements(tree).find((node) => node.props.modes && node.props.onSelect);
  const personalSetup = () =>
    elements(tree).find(
      (node) => node.props.children === "settingsPage.aiModels.managedEnterprise.usePersonalSetup"
    );
  const setupMode = () => useSettingsStore.getState().enterpriseTranscriptionSetupMode;
  for (Panel of [MeetingTranscriptionPanel, UploadTranscriptionPanel]) {
    const meeting = Panel === MeetingTranscriptionPanel;
    const routedToEnterprise = async () => {
      if (meeting) {
        await prepareTranscription();
        return meetings.at(-1).provider === "enterprise-realtime";
      }
      const settings = selectResolvedUploadTranscription(getSettings());
      await transcribeFile(
        "/recording.wav",
        { ...settings, isOpenWhisprCloud: false, getApiKey: () => "", language: "auto" },
        false
      );
      return Boolean(uploads.at(-1).managed);
    };
    await React.act(async () => {
      useSettingsStore.setState({
        isSignedIn: true,
        meetingFollowsTranscription: false,
        meetingTranscriptionMode: "local",
        uploadTranscriptionMode: "local",
        uploadUseLocalWhisper: true,
        enterpriseTranscriptionSetupMode: "auto",
      });
      useEnterpriseIdentityStore.setState({ config: { generation: 1, providers: [record] } });
      root.render(React.createElement(Harness, { key: Panel.name }));
    });

    // A managed default rollout offers only the enterprise tile plus the explicit opt-out.
    assert.equal(selector().props.activeMode, "enterprise");
    assert.deepEqual(
      selector().props.modes.map((option) => option.id),
      ["enterprise"]
    );
    assert.ok(personalSetup());
    // An ordinary mode pick never moves dictation or the other context off the gateway.
    await React.act(async () => selector().props.onSelect("providers"));
    assert.equal(setupMode(), "auto");
    assert.equal(isManagedTranscriptionActive(), true);
    assert.equal(await routedToEnterprise(), true);

    // The explicit opt-out is the only control that selects the personal setup.
    await React.act(async () => personalSetup().props.onClick());
    assert.equal(setupMode(), "manual");
    await React.act(async () => selector().props.onSelect("local"));
    assert.equal(setupMode(), "manual");
    assert.equal(selector().props.activeMode, "local");
    assert.ok(selector().props.modes.some((option) => option.id === "enterprise"));
    assert.equal(await routedToEnterprise(), false);
    if (!meeting) assert.equal(uploads.at(-1).provider, "whisper");

    await React.act(async () => selector().props.onSelect("enterprise"));
    assert.equal(setupMode(), "managed");
    assert.equal(await routedToEnterprise(), true);

    // Neither pick nor a click on the active enterprise tile overwrites the personal
    // choice, so the opt-out returns to it instead of an unroutable "enterprise".
    await React.act(async () => selector().props.onSelect("enterprise"));
    const personal = useSettingsStore.getState();
    assert.equal(
      meeting ? personal.meetingTranscriptionMode : personal.uploadTranscriptionMode,
      "local"
    );
    assert.equal(
      meeting ? personal.meetingCloudTranscriptionMode : personal.uploadCloudTranscriptionMode,
      "byok"
    );
    await React.act(async () => personalSetup().props.onClick());
    assert.equal(selector().props.activeMode, "local");
    assert.equal(await routedToEnterprise(), false);

    // Required profiles win over a stored opt-out and offer no personal setup.
    for (const overrides of [{ mode: "managed_required" }, { allowManualSetup: false }]) {
      await React.act(async () => {
        useSettingsStore.setState({ enterpriseTranscriptionSetupMode: "manual" });
        useEnterpriseIdentityStore.setState({
          config: { generation: 1, providers: [{ ...record, ...overrides }] },
        });
      });
      assert.deepEqual(
        selector().props.modes.map((option) => option.id),
        ["enterprise"]
      );
      assert.equal(personalSetup(), undefined);
      assert.equal(await routedToEnterprise(), true);
    }
  }
});
