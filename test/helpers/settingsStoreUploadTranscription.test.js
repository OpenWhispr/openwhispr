const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// Upload inherits unset values from dictation, but a realtime-only dictation
// provider has no batch route — inheriting it would fail every upload closed
// on transcriptionRoute's guard. The picker hides those providers for the
// upload scope and reconciles an unset selection to the first provider, so the
// resolved value must land on the same default.
test("upload transcription never inherits a realtime-only dictation provider", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-transcription-test-",
  });
  const { useSettingsStore, selectResolvedUploadTranscription } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const { STREAMING_ONLY_PROVIDERS } = await vite.ssrLoadModule("/helpers/transcriptionRoute.ts");
  const base = useSettingsStore.getState();

  for (const provider of STREAMING_ONLY_PROVIDERS) {
    const resolved = selectResolvedUploadTranscription({
      ...base,
      cloudTranscriptionProvider: provider,
      cloudTranscriptionModel: "nova-3",
      uploadCloudTranscriptionProvider: "",
      uploadCloudTranscriptionModel: "",
    });
    assert.equal(resolved.cloudTranscriptionProvider, "openai", provider);
    assert.equal(resolved.cloudTranscriptionModel, "", `${provider}'s model must not follow`);
  }

  // An explicit upload choice always wins, even a realtime-only one — the
  // route guard then reports it truthfully instead of silently rerouting.
  const explicit = selectResolvedUploadTranscription({
    ...base,
    cloudTranscriptionProvider: "deepgram",
    uploadCloudTranscriptionProvider: "groq",
    uploadCloudTranscriptionModel: "whisper-large-v3",
  });
  assert.equal(explicit.cloudTranscriptionProvider, "groq");
  assert.equal(explicit.cloudTranscriptionModel, "whisper-large-v3");

  // Batch-capable dictation providers keep inheriting provider and model.
  const inherited = selectResolvedUploadTranscription({
    ...base,
    cloudTranscriptionProvider: "groq",
    cloudTranscriptionModel: "whisper-large-v3-turbo",
    uploadCloudTranscriptionProvider: "",
    uploadCloudTranscriptionModel: "",
  });
  assert.equal(inherited.cloudTranscriptionProvider, "groq");
  assert.equal(inherited.cloudTranscriptionModel, "whisper-large-v3-turbo");
});

const DICTATION_URL = "http://192.168.11.83:8090";
const DICTATION_MODEL = "large-v3";
const UPLOAD_URL = "http://192.168.11.84:8090";

// A self-hosted dictation profile from before Audio Upload had its own server.
const SELF_HOSTED_DICTATION = {
  transcriptionMode: "self-hosted",
  uploadTranscriptionMode: "self-hosted",
  remoteTranscriptionUrl: DICTATION_URL,
  remoteTranscriptionModel: DICTATION_MODEL,
};
// The same profile after ≥1.7.3: the upload copy latched before the upload
// self-hosted keys existed, so migrateUploadTranscription() can never seed them.
const LATCHED_SELF_HOSTED = { ...SELF_HOSTED_DICTATION, uploadTranscriptionMigrated: "true" };

// #2049: the Upload tab's Server URL and Model wrote dictation's keys, so the
// two tabs could not point at different servers.
test("audio upload has its own self-hosted server", async (t) => {
  const { storage } = installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-self-hosted-test-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  // Migrations run once per module evaluation, so every case re-evaluates the store.
  const load = async (seed) => {
    storage.clear();
    for (const [key, value] of Object.entries(seed)) storage.setItem(key, value);
    vite.moduleGraph.invalidateAll();
    const mod = await vite.ssrLoadModule("/stores/settingsStore.ts");
    return { mod, store: mod.useSettingsStore };
  };
  const resolved = (mod, store) => mod.selectResolvedUploadTranscription(store.getState());

  await t.test(
    "uploads use only the Upload tab's URL and model, and never write dictation's",
    async () => {
      const { mod, store } = await load({});
      store.getState().setRemoteTranscriptionUrl(DICTATION_URL);
      store.getState().setRemoteTranscriptionModel(DICTATION_MODEL);
      // An empty Upload tab must not send uploads to dictation's server.
      assert.equal(resolved(mod, store).remoteTranscriptionUrl, "");
      assert.equal(resolved(mod, store).remoteTranscriptionModel, "");

      store.getState().setUploadRemoteTranscriptionUrl(UPLOAD_URL);
      store.getState().setUploadRemoteTranscriptionModel("whisper-diarize");
      const state = store.getState();
      assert.equal(state.remoteTranscriptionUrl, DICTATION_URL, "dictation URL untouched");
      assert.equal(state.remoteTranscriptionModel, DICTATION_MODEL, "dictation model untouched");
      assert.equal(resolved(mod, store).remoteTranscriptionUrl, UPLOAD_URL);
      assert.equal(resolved(mod, store).remoteTranscriptionModel, "whisper-diarize");
    }
  );

  await t.test("an existing self-hosted profile keeps its server on upgrade", async () => {
    for (const [label, seed] of [
      ["pre-1.7.3", SELF_HOSTED_DICTATION],
      ["latched ≥1.7.3", LATCHED_SELF_HOSTED],
    ]) {
      const { mod, store } = await load(seed);
      const state = store.getState();
      assert.equal(state.uploadRemoteTranscriptionUrl, DICTATION_URL, `${label}: URL shown`);
      assert.equal(state.uploadRemoteTranscriptionModel, DICTATION_MODEL, `${label}: model shown`);
      assert.equal(
        resolved(mod, store).remoteTranscriptionUrl,
        DICTATION_URL,
        `${label}: URL used`
      );
      assert.equal(storage.getItem("uploadSelfHostedMigrated"), "true", `${label}: latched`);
    }
  });

  await t.test("the seed copies only keys the upload context lacks, and only once", async () => {
    const kept = await load({ ...LATCHED_SELF_HOSTED, uploadRemoteTranscriptionUrl: UPLOAD_URL });
    assert.equal(kept.store.getState().uploadRemoteTranscriptionUrl, UPLOAD_URL, "not overwritten");
    assert.equal(kept.store.getState().uploadRemoteTranscriptionModel, DICTATION_MODEL);

    const done = await load({ ...LATCHED_SELF_HOSTED, uploadSelfHostedMigrated: "true" });
    assert.equal(storage.getItem("uploadRemoteTranscriptionUrl"), null, "no second copy");
    assert.equal(storage.getItem("uploadRemoteTranscriptionModel"), null, "no second model copy");
    assert.equal(done.store.getState().uploadRemoteTranscriptionUrl, "");

    await load({});
    assert.equal(storage.getItem("uploadSelfHostedMigrated"), "true", "fresh install latches");
    assert.equal(storage.getItem("uploadRemoteTranscriptionUrl"), null, "nothing to copy");
  });

  await t.test("the Upload tab shows its own server, not dictation's", async () => {
    await load({
      ...LATCHED_SELF_HOSTED,
      uploadRemoteTranscriptionUrl: UPLOAD_URL,
      uploadRemoteTranscriptionModel: "whisper-diarize",
    });
    const { UploadTranscriptionPanel } = await vite.ssrLoadModule(
      "/components/settings/UploadSettings.tsx"
    );
    const html = renderToStaticMarkup(React.createElement(UploadTranscriptionPanel));
    assert.ok(html.includes(UPLOAD_URL) && html.includes("whisper-diarize"), "upload server shown");
    assert.ok(
      !html.includes(DICTATION_URL) && !html.includes(DICTATION_MODEL),
      "dictation's server hidden"
    );
  });
});

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  return predicate(node) ? node : findElement(node.props?.children, predicate);
}

// The Upload tab must offer only modes an upload can run. When a managed
// policy's only allowed providers are live-only, bring-your-own-key is not one
// of them, and the tab shows the same fallback uploads actually use.
test("the Upload tab never offers bring-your-own-key through live-only providers", async (t) => {
  installBrowserGlobals(t, {
    initialStorage: {
      _providerSettingsMigrated: "1",
      uploadTranscriptionMigrated: "true",
      uploadSelfHostedMigrated: "true",
      isSignedIn: "true",
      transcriptionMode: "providers",
      cloudTranscriptionProvider: "openai",
      uploadTranscriptionMode: "providers",
    },
  });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-tab-policy-test-",
    resolveAlias: { "@": path.resolve(__dirname, "../../src") },
  });
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  const { UploadTranscriptionPanel } = await vite.ssrLoadModule(
    "/components/settings/UploadSettings.tsx"
  );
  const offered = async (allowedByokProviders) => {
    usePolicyStore.setState({
      status: "managed",
      managed: true,
      appVersion: "1.10.2",
      policy: {
        version: 1,
        transcription: {
          allowedModes: ["openwhispr", "providers", "local"],
          allowedByokProviders,
          allowedEnterpriseProviders: [],
        },
        llm: {
          allowedModes: ["openwhispr"],
          allowedByokProviders: [],
          allowedEnterpriseProviders: [],
        },
        features: { agentEnabled: true, webSearchEnabled: true },
        sharing: { externalLinkSharing: "allowed" },
        dataRetention: {
          audioRetentionMaxDays: null,
          localHistoryMode: "user_choice",
          cloudBackupAllowed: true,
        },
        minAppVersion: null,
      },
    });
    let tree = null;
    function Harness() {
      tree = UploadTranscriptionPanel();
      return null;
    }
    const root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Harness)));
    await React.act(async () => root.unmount());
    const selector = findElement(tree, (node) => Array.isArray(node.props?.modes));
    return {
      modes: selector.props.modes.map((mode) => mode.id),
      active: selector.props.activeMode,
    };
  };

  assert.deepEqual(await offered(["deepgram"]), {
    modes: ["openwhispr", "local"],
    active: "openwhispr",
  });
  assert.deepEqual(await offered(["openai", "deepgram"]), {
    modes: ["openwhispr", "providers", "local"],
    active: "providers",
  });
});

// Upload inherits dictation's endpoint, except a built-in provider's URL when
// dictation is on another provider: a Custom upload without an endpoint of its
// own then fails closed instead of posting the Custom key to that provider.
test("an upload never borrows another built-in provider's endpoint", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-upload-endpoint-inheritance-test-",
  });
  const { useSettingsStore, selectResolvedUploadTranscription } = await vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const base = useSettingsStore.getState();
  const resolvedUrl = (overrides) =>
    selectResolvedUploadTranscription({
      ...base,
      uploadCloudTranscriptionProvider: "custom",
      uploadCloudTranscriptionBaseUrl: "",
      ...overrides,
    }).cloudTranscriptionBaseUrl;

  assert.equal(
    resolvedUrl({
      cloudTranscriptionProvider: "deepgram",
      cloudTranscriptionBaseUrl: "https://api.deepgram.com/v1",
    }),
    "",
    "a built-in provider's URL stays with that provider"
  );
  // The Custom tab's own endpoint survives a later switch of dictation to another
  // provider, as when onboarding set up Custom for every scope.
  assert.equal(
    resolvedUrl({
      cloudTranscriptionProvider: "openai",
      cloudTranscriptionBaseUrl: "https://stt.example.com/v1",
    }),
    "https://stt.example.com/v1"
  );
  assert.equal(
    resolvedUrl({
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionBaseUrl: "https://stt.example.com/v1",
      uploadCloudTranscriptionProvider: "",
    }),
    "https://stt.example.com/v1"
  );
});
