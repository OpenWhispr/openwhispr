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
  workspaceId: "workspace-a", version: 1, generation: 1, identity,
  providers: [{
    provider: "azure", mode: "managed_default", allowManualSetup: true,
    config: { tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222", endpoint: "https://example.openai.azure.com", apiVersion: "preview", transcription: { allowedDeployments: ["gpt-4o-transcribe"], defaultDeployment: "gpt-4o-transcribe" } },
    version: 1, updatedAt: "2026-08-10T00:00:00.000Z",
  }],
};
const policy = {
  version: 1,
  transcription: { allowedModes: ["enterprise", "openwhispr", "local"], allowedByokProviders: [], allowedEnterpriseProviders: ["azure"] },
  llm: { allowedModes: ["openwhispr"], allowedByokProviders: [], allowedEnterpriseProviders: [] },
  features: { agentEnabled: true, webSearchEnabled: false },
  sharing: { externalLinkSharing: "disabled" },
  dataRetention: { audioRetentionMaxDays: null, localHistoryMode: "user_choice", cloudBackupAllowed: false },
  minAppVersion: null,
};
const cfg = (overrides) => ({
  useLocalWhisper: false, localTranscriptionProvider: "whisper", whisperModel: "base", parakeetModel: "p", cohereModel: "c",
  isOpenWhisprCloud: false, getApiKey: () => "", cloudTranscriptionProvider: "openai", cloudTranscriptionBaseUrl: "",
  cloudTranscriptionModel: "whisper-1", language: "en", transcriptionMode: "providers", ...overrides,
});

test("managed transcription outranks OpenWhispr Cloud and local Whisper on the upload lane", async (t) => {
  const { window } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-file-managed-",
    mockModules: { "/lib/auth": "export const withSessionRefresh = (fn) => fn();" },
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule("/stores/enterpriseIdentityStore.ts");
  const { transcribeFile } = await vite.ssrLoadModule("/services/fileTranscription.ts");
  usePolicyStore.setState({ status: "managed", appVersion: "1.10.0", policy });
  useEnterpriseIdentityStore.setState({ accountId: "account-a", workspaceId: "workspace-a", authGeneration: 1, status: "ready", config: sttDefault, error: null, managedScopes: ["transcription"], enforcedScopes: [] });

  const calls = { cloud: 0, local: 0, byok: [] };
  window.electronAPI.transcribeAudioFileCloud = async () => { calls.cloud += 1; return { success: true, text: "cloud" }; };
  window.electronAPI.transcribeAudioFile = async () => { calls.local += 1; return { success: true, text: "local" }; };
  window.electronAPI.transcribeAudioFileByok = async (args) => { calls.byok.push(args); return { success: true, text: "managed" }; };

  for (const config of [cfg({ isOpenWhisprCloud: true }), cfg({ useLocalWhisper: true }), cfg({})]) {
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
});
