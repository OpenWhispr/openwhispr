const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const japanese = require("../../src/locales/ja/translation.json");

const cloudSettings = () => ({
  transcriptionMode: "providers",
  useLocalWhisper: false,
  localTranscriptionProvider: "whisper",
  whisperModel: "tiny",
  parakeetModel: "",
  cloudTranscriptionProvider: "openai",
  cloudTranscriptionModel: "gpt-4o-transcribe",
});

test("managed transcription resolves every renderer runtime scope fail closed", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-managed-transcription-runtime-",
  });
  const { resolveManagedLocalTranscriptionRuntime } = await vite.ssrLoadModule(
    "/helpers/managedLocalTranscriptionRuntime.ts"
  );
  const { useEnterpriseIdentityStore } = await vite.ssrLoadModule(
    "/stores/enterpriseIdentityStore.ts"
  );
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { default: i18n } = await vite.ssrLoadModule("/i18n.ts");
  await i18n.changeLanguage("ja");
  const identity = { accountId: "account-a", workspaceId: "workspace-a", authGeneration: 4 };

  usePolicyStore.setState({ status: "unmanaged", managed: false, policy: null });
  useEnterpriseIdentityStore.setState({
    ...identity,
    status: "error",
    config: null,
    lastKnownLocalModels: null,
    lastKnownLocalModelsKnown: false,
    failClosed: true,
  });
  for (const scope of ["dictation", "meeting", "upload", "file"]) {
    const resolution = resolveManagedLocalTranscriptionRuntime({
      ...cloudSettings(),
      scope,
    });
    assert.equal(resolution.kind, "error", `${scope} must not retain a cloud route`);
    assert.equal(resolution.code, "MANAGED_CONFIG_UNAVAILABLE");
    assert.equal(resolution.message, japanese.managedLocalModels.runtime.transcriptionUnavailable);
  }

  const selection = { provider: "nvidia", modelId: "nvidia-parakeet-tdt-0.6b-v3" };
  const localModels = {
    version: 9,
    updatedAt: new Date(0).toISOString(),
    updatedByUserId: null,
    transcription: [selection],
    reasoning: [],
  };
  storage.setItem(
    "enterpriseManagedLocalModelBindingsV1",
    JSON.stringify({
      "account-a:workspace-a": {
        configVersion: 9,
        transcription: selection,
        reasoning: null,
        error: null,
      },
    })
  );
  useEnterpriseIdentityStore.setState({
    ...identity,
    status: "ready",
    config: { localModels },
    lastKnownLocalModels: localModels,
    lastKnownLocalModelsKnown: true,
    failClosed: false,
  });
  for (const scope of ["dictation", "meeting", "upload", "file"]) {
    const resolution = resolveManagedLocalTranscriptionRuntime({
      ...cloudSettings(),
      scope,
    });
    assert.equal(resolution.kind, "ready");
    assert.equal(resolution.managed, true);
    assert.deepEqual(
      [
        resolution.settings.transcriptionMode,
        resolution.settings.useLocalWhisper,
        resolution.settings.localTranscriptionProvider,
        resolution.settings.parakeetModel,
      ],
      ["local", true, "nvidia", selection.modelId]
    );
  }

  usePolicyStore.setState({
    status: "managed",
    managed: true,
    policy: {
      transcription: { allowedModes: ["providers"], allowedByokProviders: ["openai"] },
    },
  });
  const policyBlocked = resolveManagedLocalTranscriptionRuntime(cloudSettings());
  assert.equal(policyBlocked.kind, "error");
  assert.equal(policyBlocked.message, japanese.common.policyTranscriptionRestricted);

  useEnterpriseIdentityStore.setState({
    ...identity,
    status: "ready",
    config: { localModels: { ...localModels, transcription: [] } },
    lastKnownLocalModels: { ...localModels, transcription: [] },
    lastKnownLocalModelsKnown: true,
    failClosed: false,
  });
  assert.deepEqual(resolveManagedLocalTranscriptionRuntime(cloudSettings()), {
    kind: "ready",
    managed: false,
    settings: cloudSettings(),
  });
});
