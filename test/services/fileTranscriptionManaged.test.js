const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

const identity = {
  issuer: "https://api.example.com/enterprise-identity",
  jwksUri: "https://api.example.com/enterprise-identity/jwks.json",
  subject: "workspace:workspace-a",
  audiences: { bedrock: "sts.amazonaws.com", azure: "api://AzureADTokenExchange" },
};
const sttDefault = {
  workspaceId: "workspace-a",
  version: 1,
  generation: 1,
  identity,
  providers: [
    {
      provider: "azure",
      mode: "managed_default",
      allowManualSetup: true,
      config: {
        tenantId: "11111111-1111-4111-8111-111111111111",
        clientId: "22222222-2222-4222-8222-222222222222",
        endpoint: "https://example.openai.azure.com",
        apiVersion: "preview",
        transcription: {
          allowedDeployments: ["gpt-4o-transcribe"],
          defaultDeployment: "gpt-4o-transcribe",
        },
      },
      version: 1,
      updatedAt: "2026-08-10T00:00:00.000Z",
    },
  ],
};
const policy = {
  version: 1,
  transcription: {
    allowedModes: ["enterprise", "openwhispr", "local"],
    allowedByokProviders: [],
    allowedEnterpriseProviders: ["azure"],
  },
  llm: { allowedModes: ["openwhispr"], allowedByokProviders: [], allowedEnterpriseProviders: [] },
  features: { agentEnabled: true, webSearchEnabled: false },
  sharing: { externalLinkSharing: "disabled" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: false,
  },
  minAppVersion: null,
};
const cfg = (overrides) => ({
  useLocalWhisper: false,
  localTranscriptionProvider: "whisper",
  whisperModel: "base",
  parakeetModel: "p",
  cohereModel: "c",
  isOpenWhisprCloud: false,
  getApiKey: () => "",
  cloudTranscriptionProvider: "openai",
  cloudTranscriptionBaseUrl: "",
  cloudTranscriptionModel: "whisper-1",
  language: "en",
  transcriptionMode: "providers",
  ...overrides,
});

test("managed transcription outranks OpenWhispr Cloud and local Whisper on the upload lane", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-file-managed-",
    mockModules: { "/lib/auth": "export const withSessionRefresh = (fn) => fn();" },
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { transcribeFile } = await vite.ssrLoadModule("/services/fileTranscription.ts");
  usePolicyStore.setState({ status: "managed", appVersion: "1.10.0", policy });
  useEnterpriseIdentityStore.setState({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    status: "ready",
    config: sttDefault,
    error: null,
    managedScopes: ["transcription"],
    enforcedScopes: [],
  });

  const calls = { cloud: 0, local: 0, byok: [] };
  window.electronAPI.transcribeAudioFileCloud = async () => {
    calls.cloud += 1;
    return { success: true, text: "cloud" };
  };
  window.electronAPI.transcribeAudioFile = async () => {
    calls.local += 1;
    return { success: true, text: "local" };
  };
  window.electronAPI.transcribeAudioFileByok = async (args) => {
    calls.byok.push(args);
    return { success: true, text: "managed" };
  };

  for (const config of [
    cfg({ isOpenWhisprCloud: true }),
    cfg({ useLocalWhisper: true }),
    cfg({}),
  ]) {
    const result = await transcribeFile("/tmp/a.wav", config, true);
    assert.equal(result.text, "managed");
  }
  assert.equal(calls.cloud, 0);
  assert.equal(calls.local, 0);
  assert.equal(calls.byok.length, 3);
  for (const args of calls.byok) {
    assert.equal(args.managed.kind, "managed");
    assert.equal(args.managed.deployment, "gpt-4o-transcribe");
  }

  // A managed resolution error (config confirmed gone, scope enforced) must
  // fail closed: no cloud, no local, and no BYOK call either — the error
  // short-circuit in transcribeFile is load-bearing, not just redundant with
  // the `!managed &&` guards below it.
  useEnterpriseIdentityStore.setState({
    accountId: "account-a",
    workspaceId: "workspace-a",
    authGeneration: 1,
    status: "error",
    config: null,
    error: "offline",
    managedScopes: ["transcription"],
    enforcedScopes: ["transcription"],
  });
  const errorResult = await transcribeFile("/tmp/a.wav", cfg({ isOpenWhisprCloud: true }), true);
  assert.equal(errorResult.success, false);
  assert.equal(errorResult.code, "MANAGED_CONFIG_UNAVAILABLE");
  assert.equal(calls.cloud, 0);
  assert.equal(calls.local, 0);
  assert.equal(calls.byok.length, 3);
});

test("an upload waits for a stale personal route and respects cancellation during that wait", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t);
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { transcribeFileWithSpeakers } = await vite.ssrLoadModule("/services/fileTranscription.ts");
  const scope = { accountId: "account-a", workspaceId: "workspace-a", authGeneration: 1 };
  let now = 0;
  t.mock.method(Date, "now", () => now);
  usePolicyStore.setState({ status: "unmanaged" });
  window.electronAPI.getManagedEnterpriseConfig = async () => ({
    ...scope,
    success: false,
    code: "ENTERPRISE_REQUIRED",
  });
  await useEnterpriseIdentityStore
    .getState()
    .refresh(scope.accountId, scope.workspaceId, scope.authGeneration);
  now += 5 * 60_000;
  const reply = Promise.withResolvers();
  const recheck = t.mock.fn(() => reply.promise);
  window.electronAPI.getManagedEnterpriseConfig = recheck;
  const upload = t.mock.fn(async () => ({ success: true, text: "managed" }));
  window.electronAPI.transcribeAudioFileByok = upload;
  let cancelled = false;
  const send = (isCancelled) =>
    transcribeFileWithSpeakers(
      "/tmp/a.wav",
      cfg({ isOpenWhisprCloud: true }),
      { enabled: false },
      null,
      { isCancelled }
    );
  const first = send(() => cancelled);
  const second = send(() => false);
  assert.equal(recheck.mock.callCount(), 1);
  assert.equal(upload.mock.callCount(), 0);
  cancelled = true;
  reply.resolve({ ...scope, success: true, config: sttDefault });
  assert.equal((await first).code, "AUDIO_OPERATION_CANCELLED");
  assert.equal((await second).text, "managed");
  assert.equal(upload.mock.callCount(), 1);
  assert.equal(upload.mock.calls[0].arguments[0].managed.provider, "azure");
});
