const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const path = require("node:path");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

const config = (mode = "managed_default", allowManualSetup = true) => ({
  workspaceId: "workspace-a",
  version: 1,
  generation: 1,
  identity: {
    issuer: "https://example.com",
    jwksUri: "https://example.com/jwks",
    subject: "workspace:workspace-a",
    audiences: { azure: "api://AzureADTokenExchange", bedrock: "sts.amazonaws.com" },
  },
  providers: [
    {
      provider: "azure",
      mode,
      allowManualSetup,
      version: 1,
      updatedAt: "2026-10-15T00:00:00Z",
      config: {
        tenantId: "tenant",
        clientId: "client",
        endpoint: "https://example.openai.azure.com",
        apiVersion: "preview",
        transcription: {
          allowedDeployments: ["gpt-4o-transcribe"],
          defaultDeployment: "gpt-4o-transcribe",
        },
      },
    },
  ],
});

async function setup(
  t,
  { panel = false, mode, allowManualSetup, paths = ["/tmp/silent.wav"] } = {}
) {
  let root;
  let reasoning;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    reasoning?.destroy();
  });
  const { window } = installBrowserGlobals(t, {
    window: {
      electronAPI: {
        selectAudioFile: async () => ({ canceled: false, filePaths: paths }),
        getFileSize: async () => 1024,
        cancelUrlDownload() {},
        listWhisperModels: async () => ({
          success: true,
          models: [{ model: "base", downloaded: true }],
        }),
        getDiarizationModelStatus: async () => ({ modelsDownloaded: false }),
      },
    },
  });
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, {
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
    mockModules: {
      "/hooks/useAuth": "export const useAuth = () => ({ isSignedIn: true });",
      // The personal picker owns downloads/credentials; only its surrounding route controls are under test.
      "/TranscriptionModelPicker": "export default function Picker() { return null; }",
      "/hooks/useUsage": "export const useUsage = () => null;",
      "/hooks/useSettings": "export const useSettings = () => ({ openaiApiKey: 'test-key' });",
      "/lib/auth": "export const withSessionRefresh = (fn) => fn();",
    },
  });
  await vite.ssrLoadModule("/i18n.ts");
  const { useSettingsStore: settings } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore: policy } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useEnterpriseIdentityStore: identity } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  settings.setState({
    isSignedIn: true,
    uploadTranscriptionMode: "providers",
    uploadUseLocalWhisper: false,
    uploadCloudTranscriptionMode: "byok",
    uploadCloudTranscriptionProvider: "openai",
    uploadCloudTranscriptionModel: "gpt-4o-mini-transcribe",
    enterpriseTranscriptionSetupMode: "auto",
    enterpriseSetupMode: "manual",
    useCleanupModel: false,
  });
  policy.setState({ status: "unmanaged", policy: null });
  identity.setState({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    status: "ready",
    config: config(mode, allowManualSetup),
    managedScopes: ["transcription"],
    enforcedScopes: mode === "managed_required" ? ["transcription"] : [],
  });
  const component = panel
    ? (await vite.ssrLoadModule("/components/settings/UploadSettings.tsx")).UploadTranscriptionPanel
    : (await vite.ssrLoadModule("/components/notes/UploadAudioView.tsx")).default;
  if (!panel) reasoning = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(component)));
  const click = async (label) => {
    const element = findElement(
      container,
      (node) =>
        node.getAttribute("aria-label") === label ||
        (node.tagName === "BUTTON" && node.textContent === label)
    );
    assert.ok(element, `Missing control ${label}: ${container.textContent}`);
    await React.act(async () => {
      element.dispatchEvent({ type: "click", bubbles: true, button: 0 });
    });
  };
  return { container, settings, identity, policy, window, click, vite };
}

test("Upload settings shows effective managed STT and preserves personal selections when switching global setup", async (t) => {
  const { container, settings, click } = await setup(t, { panel: true });
  assert.match(container.textContent, /Managed by your organization/);
  assert.match(container.textContent, /Azure.*gpt-4o-transcribe/);
  assert.doesNotMatch(container.textContent, /gpt-4o-mini-transcribe/);
  await click("Use personal setup");
  assert.equal(settings.getState().enterpriseTranscriptionSetupMode, "manual");
  assert.equal(settings.getState().enterpriseSetupMode, "manual");
  assert.equal(settings.getState().uploadCloudTranscriptionProvider, "openai");
  assert.equal(settings.getState().uploadCloudTranscriptionModel, "gpt-4o-mini-transcribe");
  await click("Use managed");
  assert.match(container.textContent, /Azure.*gpt-4o-transcribe/);
});

for (const options of [{ mode: "managed_required" }, { allowManualSetup: false }]) {
  test(`Upload settings cannot choose personal setup with ${JSON.stringify(options)}`, async (t) => {
    const { container, settings } = await setup(t, { panel: true, ...options });
    await React.act(async () => settings.getState().setEnterpriseTranscriptionSetupMode("manual"));
    assert.match(container.textContent, /Azure.*gpt-4o-transcribe/);
    assert.doesNotMatch(container.textContent, /Use personal setup/);
  });
}

for (const paths of [["/tmp/silent.wav"], ["/tmp/one.wav", "/tmp/two.wav"]]) {
  test(`Upload ${paths.length === 1 ? "single badge and progress" : "batch badge"} agree with managed dispatch`, async (t) => {
    const { container, click, window, settings } = await setup(t, { paths });
    assert.match(container.textContent, /Azure.*gpt-4o-transcribe/);
    let resolveRequest;
    const requests = [];
    window.electronAPI.transcribeAudioFileByok = async (args) => {
      requests.push(args);
      return new Promise((resolve) => {
        resolveRequest = resolve;
      });
    };
    await click("Drop an audio or video file, or click to browse");
    assert.match(container.textContent, /Azure.*gpt-4o-transcribe/);
    await click("Transcribe");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].managed.deployment, "gpt-4o-transcribe");
    if (paths.length === 1) {
      assert.match(container.textContent, /Transcribing via Azure/);
      await React.act(async () =>
        settings.getState().setEnterpriseTranscriptionSetupMode("manual")
      );
      assert.match(
        container.textContent,
        /Transcribing via Azure/,
        "in-flight progress must retain the dispatched route"
      );
    }
    await click(paths.length === 1 ? "Cancel transcription" : "Cancel all");
    await React.act(async () => resolveRequest({ success: false, error: "cancelled" }));
  });
}

test("managed config failure hides personal readiness and settings; unrelated LLM failure leaves personal Upload available", async (t) => {
  const { container, identity, settings } = await setup(t);
  await React.act(async () =>
    identity.setState({ status: "error", config: null, enforcedScopes: ["transcription"] })
  );
  assert.match(container.textContent, /Managed enterprise access is unavailable/);
  assert.doesNotMatch(container.textContent, /Using Openai|Drop audio|Add an API key/);
  await React.act(async () => {
    identity.setState({
      managedScopes: ["dictationCleanup"],
      enforcedScopes: ["dictationCleanup"],
    });
    settings.setState({ enterpriseTranscriptionSetupMode: "manual" });
  });
  assert.match(container.textContent, /Openai.*gpt-4o-mini-transcribe/);
});

test("Upload settings fails closed while transcription config is unavailable", async (t) => {
  const { container, identity } = await setup(t, { panel: true });
  await React.act(async () =>
    identity.setState({ config: null, status: "error", enforcedScopes: ["transcription"] })
  );
  assert.match(container.textContent, /Managed enterprise access is unavailable/);
  assert.doesNotMatch(container.textContent, /Cloud Providers|Use personal setup/);
});

test("Upload badge reacts to manual, local, and restored managed setup without changing personal fields", async (t) => {
  const { container, settings } = await setup(t);
  await React.act(async () => settings.getState().setEnterpriseTranscriptionSetupMode("manual"));
  assert.match(container.textContent, /Openai.*gpt-4o-mini-transcribe/);
  await React.act(async () =>
    settings.setState({
      uploadTranscriptionMode: "local",
      uploadUseLocalWhisper: true,
      uploadWhisperModel: "base",
      uploadLocalTranscriptionProvider: "whisper",
    })
  );
  assert.match(container.textContent, /Whisper.*base/);
  await React.act(async () => settings.getState().setEnterpriseTranscriptionSetupMode("managed"));
  assert.match(container.textContent, /Azure.*gpt-4o-transcribe/);
  assert.equal(settings.getState().uploadWhisperModel, "base");
  assert.equal(settings.getState().uploadCloudTranscriptionModel, "gpt-4o-mini-transcribe");
});

test("enterprise selector preserves the personal local route for returning to manual setup", async (t) => {
  const { container, settings, policy, click } = await setup(t, { panel: true });
  await React.act(async () => {
    settings.setState({
      enterpriseTranscriptionSetupMode: "manual",
      uploadTranscriptionMode: "local",
      uploadUseLocalWhisper: true,
      uploadCloudTranscriptionMode: "byok",
    });
    policy.setState({
      status: "managed",
      policy: {
        version: 1,
        transcription: {
          allowedModes: ["enterprise", "providers", "local"],
          allowedByokProviders: ["openai"],
          allowedEnterpriseProviders: ["azure"],
        },
        llm: { allowedModes: ["local"], allowedByokProviders: [], allowedEnterpriseProviders: [] },
        features: { agentEnabled: true, webSearchEnabled: false },
        sharing: { externalLinkSharing: "disabled" },
        dataRetention: {
          audioRetentionMaxDays: null,
          localHistoryMode: "user_choice",
          cloudBackupAllowed: false,
        },
        minAppVersion: null,
      },
    });
  });
  const enterprise = findElement(
    container,
    (node) => node.tagName === "BUTTON" && node.textContent.startsWith("Enterprise cloud")
  );
  assert.ok(enterprise, container.textContent);
  await React.act(async () =>
    enterprise.dispatchEvent({ type: "click", bubbles: true, button: 0 })
  );
  assert.match(container.textContent, /Azure.*gpt-4o-transcribe/);
  await click("Use personal setup");
  assert.equal(settings.getState().uploadTranscriptionMode, "local");
  assert.equal(settings.getState().uploadUseLocalWhisper, true);
  assert.equal(settings.getState().uploadCloudTranscriptionMode, "byok");
});

for (const availability of ["absent", "LLM-only"]) {
  test(`Upload does not offer enterprise transcription when managed config is ${availability}`, async (t) => {
    const { container, settings, identity, policy } = await setup(t, { panel: true });
    const llmConfig = config();
    delete llmConfig.providers[0].config.transcription;
    llmConfig.providers[0].config.allowedDeployments = ["gpt-4o"];
    llmConfig.providers[0].config.scopeDefaults = { noteFormatting: "gpt-4o" };
    await React.act(async () => {
      settings.setState({ enterpriseTranscriptionSetupMode: "manual" });
      identity.setState({
        config: availability === "absent" ? null : llmConfig,
        managedScopes: availability === "absent" ? [] : ["noteFormatting"],
        enforcedScopes: [],
      });
      policy.setState({
        status: "managed",
        policy: {
          version: 1,
          transcription: {
            allowedModes: ["enterprise", "providers", "local"],
            allowedByokProviders: ["openai"],
            allowedEnterpriseProviders: ["azure"],
          },
          llm: {
            allowedModes: ["enterprise", "local"],
            allowedByokProviders: [],
            allowedEnterpriseProviders: ["azure"],
          },
          features: { agentEnabled: true, webSearchEnabled: false },
          sharing: { externalLinkSharing: "disabled" },
          dataRetention: {
            audioRetentionMaxDays: null,
            localHistoryMode: "user_choice",
            cloudBackupAllowed: false,
          },
          minAppVersion: null,
        },
      });
    });
    assert.doesNotMatch(container.textContent, /Enterprise cloud|Use managed/);
    assert.match(container.textContent, /Cloud Providers/);
    assert.equal(settings.getState().enterpriseTranscriptionSetupMode, "manual");
    assert.equal(settings.getState().uploadCloudTranscriptionProvider, "openai");
    assert.equal(settings.getState().uploadCloudTranscriptionModel, "gpt-4o-mini-transcribe");
  });
}
