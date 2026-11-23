const assert = require("node:assert/strict");
const test = require("node:test");
const { mountSettingsPanel } = require("../lib/settingsPanelHarness");
const {
  managedPolicy,
  assemblyAiPolicy,
  loadAssemblyAiDictationCatalog,
  setManagedBedrockCleanup,
} = require("../helpers/harness/policyFixtures");

const PICKER = "/components/TranscriptionModelPicker.tsx";
const KEY = "common.apiKey";
const ENDPOINT = "transcription.endpointUrl";
const CUSTOM_KEY = "transcription.apiKeyOptional";
const MODEL = "common.model";
const CLIENT_ID = "transcription.corti.clientId";
const CLIENT_SECRET = "transcription.corti.clientSecret";
const TENANT = "transcription.corti.tenant";
const REJECTED = { success: false, errorCode: "credentialsRejected", status: 401 };
// The picker's download hooks subscribe at mount.
const DOWNLOADS = {
  onWhisperDownloadProgress: () => () => {},
  onParakeetDownloadProgress: () => () => {},
};
const props = (overrides = {}) => ({
  transcriptionContext: "dictation",
  selectedCloudProvider: "groq",
  onCloudProviderSelect() {},
  selectedCloudModel: "whisper-large-v3-turbo",
  onCloudModelSelect() {},
  selectedLocalModel: "",
  onLocalModelSelect() {},
  useLocalWhisper: false,
  onModeChange() {},
  cloudTranscriptionBaseUrl: "",
  setCloudTranscriptionBaseUrl() {},
  mode: "cloud",
  ...overrides,
});
const mount = (t, { overrides, ...options } = {}) =>
  mountSettingsPanel(t, {
    module: PICKER,
    props: props(overrides),
    electronAPI: DOWNLOADS,
    ...options,
  });

test("a key is checked with the panel's model, or alone under a browsed tab", async (t) => {
  const panel = await mount(t, { secrets: { groqApiKey: "gsk-saved", openaiApiKey: "sk-saved" } });
  await panel.wait(0);
  assert.deepEqual(panel.requests(), [
    {
      scope: "transcription",
      provider: "groq",
      apiKey: "gsk-saved",
      model: "whisper-large-v3-turbo",
    },
  ]);
  assert.equal(panel.checkField().props.invalidOn, "credentialsRejected");
  await panel.selectTab("openai");
  await panel.wait(0);
  assert.deepEqual(panel.requests().at(-1), {
    scope: "transcription",
    provider: "openai",
    apiKey: "sk-saved",
    model: "",
  });
});

test("a hidden picker sends nothing until it is shown, then asks again", async (t) => {
  const panel = await mount(t, { secrets: { groqApiKey: "gsk-saved" }, visible: false });
  await panel.wait(5000);
  assert.equal(panel.requests().length, 0);
  await panel.setVisible(true);
  await panel.wait(0);
  assert.equal(panel.requests().length, 1);
  await panel.answer({ success: true });
  await panel.setVisible(false);
  await panel.setVisible(true);
  await panel.wait(0);
  assert.equal(panel.requests().length, 2, "a shown panel asks again");
});

test("a key saves trimmed once its check passes, never half typed", async (t) => {
  const panel = await mount(t);
  await panel.type(KEY, " gsk-pas");
  await panel.type(KEY, " gsk-pasted ");
  await panel.wait(500); // the key still has focus, so the pause runs
  assert.deepEqual(
    panel.requests().map((config) => config.apiKey),
    ["gsk-pasted"]
  );
  assert.equal(panel.state().groqApiKey, "", "nothing is saved while the key is typed");
  await panel.answer({ success: true });
  assert.equal(panel.state().groqApiKey, "gsk-pasted", "a passing key saves at once");
});

test("Corti: the secret holds the status, checked with ID, region and tenant", async (t) => {
  const panel = await mount(t, {
    overrides: { selectedCloudProvider: "corti", selectedCloudModel: "corti-transcribe" },
    secrets: {
      cortiClientId: "corti-id",
      cortiClientSecret: "corti-secret",
      cortiEnvironment: "eu",
      cortiTenant: "",
    },
  });
  assert.ok(panel.field(CLIENT_SECRET).props.check);
  assert.equal(panel.field(CLIENT_SECRET).props.invalidOn, "credentialsRejected");
  assert.equal(panel.field(CLIENT_SECRET).props.type, "password");
  assert.equal(panel.field(CLIENT_ID).props.check, undefined);
  assert.equal(panel.field(CLIENT_ID).props.type, "text", "a client ID is not a secret");
  assert.equal(panel.field(TENANT).props.check, undefined);
  await panel.wait(0);
  assert.deepEqual(panel.requests(), [
    {
      scope: "transcription",
      provider: "corti",
      clientId: "corti-id",
      clientSecret: "corti-secret",
      environment: "eu",
      tenant: "",
    },
  ]);
  await panel.choose("us");
  await panel.wait(0); // choosing a region checks at once
  assert.equal(panel.requests().at(-1).environment, "us");
  await panel.type(CLIENT_ID, " corti-id-2 ");
  assert.equal(panel.state().cortiClientId, "corti-id", "nothing is saved while it is typed");
  await panel.blur(CLIENT_ID);
  await panel.wait(0); // leaving the field checks at once
  await panel.answer({ success: false, errorCode: "network", unverified: true });
  assert.equal(panel.state().cortiClientId, "corti-id-2", "leaving the field saves it");
});

test("Custom: the model holds the status, and the address waits until it is left", async (t) => {
  const typed = [];
  const panel = await mount(t, {
    overrides: {
      selectedCloudProvider: "custom",
      selectedCloudModel: "whisper-1",
      setCloudTranscriptionBaseUrl: (value) => typed.push(value),
    },
  });
  assert.ok(panel.field(MODEL).props.check);
  assert.equal(
    panel.field(MODEL).props.invalidOn,
    "modelNotFound",
    "a missing model is the model's fault"
  );
  await panel.focus(ENDPOINT);
  for (const url of ["http://127.0.0.1", "http://127.0.0.1:8000/v1"]) {
    await panel.type(ENDPOINT, url);
    await panel.setProps({ cloudTranscriptionBaseUrl: url });
    await panel.wait(2000);
  }
  assert.deepEqual(typed, ["http://127.0.0.1", "http://127.0.0.1:8000/v1"]);
  assert.equal(panel.requests().length, 0);
  assert.equal(panel.phase(), "idle");
  await panel.blur(ENDPOINT, { windowSwitch: true });
  await panel.wait(2000);
  assert.equal(panel.requests().length, 0, "switching apps keeps the hold");
  await panel.blur(ENDPOINT);
  assert.equal(panel.phase(), "waiting");
  await panel.wait(0); // leaving the fields checks at once
  assert.deepEqual(panel.requests(), [
    {
      scope: "transcription",
      provider: "custom",
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "",
      model: "whisper-1",
    },
  ]);
  await panel.answer(REJECTED);
  assert.equal(panel.field(MODEL).props.failureReason, "reasoning.custom.endpointUnauthorized");
});

test("Custom: an Azure endpoint is not checked, any other address is", async (t) => {
  const panel = await mount(t, {
    overrides: {
      selectedCloudProvider: "custom",
      selectedCloudModel: "whisper-deployment",
      cloudTranscriptionBaseUrl: "https://my-resource.cognitiveservices.azure.com",
    },
  });
  await panel.wait(5000);
  assert.equal(panel.requests().length, 0, "Azure takes its own URL and api-key header");
  assert.equal(panel.phase(), "idle");
  await panel.setProps({ cloudTranscriptionBaseUrl: "http://127.0.0.1:8000/v1" });
  await panel.wait(500);
  assert.deepEqual(
    panel.requests().map((config) => config.baseUrl),
    ["http://127.0.0.1:8000/v1"]
  );
});

test("leaving an address that is tidied on blur checks at once", async (t) => {
  // The setter saves straight into the picker's props, as the store does for its parent, so
  // the tidied address and the hold's drop reach the picker in one render.
  const live = props({
    selectedCloudProvider: "custom",
    selectedCloudModel: "whisper-1",
    cloudTranscriptionBaseUrl: "http://127.0.0.1:8080/v1/",
  });
  live.setCloudTranscriptionBaseUrl = (value) => {
    live.cloudTranscriptionBaseUrl = value;
  };
  const panel = await mountSettingsPanel(t, {
    module: PICKER,
    props: live,
    electronAPI: DOWNLOADS,
  });
  await panel.wait(0);
  await panel.answer({ success: true });
  await panel.focus(ENDPOINT);
  await panel.blur(ENDPOINT); // the hold drops and the address is saved without its slash
  assert.equal(live.cloudTranscriptionBaseUrl, "http://127.0.0.1:8080/v1");
  await panel.wait(0);
  assert.deepEqual(
    panel.requests().map((config) => config.baseUrl),
    ["http://127.0.0.1:8080/v1/", "http://127.0.0.1:8080/v1"],
    "leaving the address checks it at once"
  );
});

test("moving focus between the panel's own fields keeps the pause", async (t) => {
  const panel = await mount(t, {
    overrides: {
      selectedCloudProvider: "custom",
      selectedCloudModel: "whisper-1",
      cloudTranscriptionBaseUrl: "http://127.0.0.1:8000/v1",
    },
  });
  await panel.wait(0);
  await panel.answer({ success: true });
  await panel.type(CUSTOM_KEY, "sk-server");
  await panel.wait(300);
  await panel.focus(MODEL); // focus moves from the key to the model, inside the panel
  await panel.wait(199);
  assert.equal(panel.requests().length, 1, "nothing before the pause ends");
  await panel.wait(1);
  assert.deepEqual(
    panel.requests().map((config) => config.apiKey),
    ["", "sk-server"]
  );
});

test("Note Recording checks its streaming providers' keys too", async (t) => {
  const panel = await mount(t, {
    overrides: {
      transcriptionContext: "meeting",
      streamingOnly: true,
      selectedCloudProvider: "deepgram",
      selectedCloudModel: "nova-3",
    },
    secrets: { deepgramApiKey: "dg-saved" },
  });
  await panel.wait(0);
  assert.deepEqual(panel.requests(), [
    { scope: "transcription", provider: "deepgram", apiKey: "dg-saved", model: "nova-3" },
  ]);
});

test("Corti: nothing of a refused setup is saved, not even its client ID", async (t) => {
  const panel = await mount(t, {
    overrides: { selectedCloudProvider: "corti", selectedCloudModel: "corti-transcribe" },
    secrets: {
      cortiClientId: "corti-id",
      cortiClientSecret: "corti-secret",
      cortiEnvironment: "eu",
      cortiTenant: "",
    },
  });
  await panel.wait(0);
  await panel.answer({ success: true });
  await panel.type(CLIENT_SECRET, "wrong-secret");
  await panel.blur(CLIENT_SECRET);
  await panel.wait(0);
  await panel.answer(REJECTED);
  assert.equal(panel.state().cortiClientSecret, "corti-secret");
  // A refusal can't say which part is wrong, so it holds back every part that was typed.
  await panel.type(CLIENT_ID, "corti-id-2");
  await panel.blur(CLIENT_ID);
  await panel.wait(0);
  await panel.answer(REJECTED);
  assert.equal(panel.state().cortiClientId, "corti-id");
  await panel.type(CLIENT_SECRET, "other-secret"); // the refused ID still holds the setup back
  await panel.unmount();
  assert.deepEqual(
    [panel.state().cortiClientId, panel.state().cortiClientSecret],
    ["corti-id", "corti-secret"],
    "the working setup stays"
  );
});

test("Custom: a key the server refuses still saves once its field is left", async (t) => {
  const panel = await mount(t, {
    overrides: {
      selectedCloudProvider: "custom",
      selectedCloudModel: "whisper-1",
      cloudTranscriptionBaseUrl: "http://127.0.0.1:8000/v1",
    },
    secrets: { customTranscriptionApiKey: "sk-local" },
  });
  await panel.wait(0);
  await panel.answer({ success: true });
  await panel.type(CUSTOM_KEY, "sk-wrong");
  await panel.blur(CUSTOM_KEY);
  await panel.wait(0);
  await panel.answer(REJECTED);
  assert.equal(panel.state().customTranscriptionApiKey, "sk-wrong");
});

test("Corti: a refused secret stays in its field while another field is fixed", async (t) => {
  const panel = await mount(t, {
    overrides: { selectedCloudProvider: "corti", selectedCloudModel: "corti-transcribe" },
    secrets: {
      cortiClientId: "id",
      cortiClientSecret: "",
      cortiEnvironment: "eu",
      cortiTenant: "",
    },
  });
  await panel.type(CLIENT_SECRET, "right-secret");
  await panel.blur(CLIENT_SECRET);
  await panel.wait(0);
  await panel.answer(REJECTED); // refused because the tenant is wrong
  await panel.type(TENANT, "acme");
  assert.equal(panel.field(CLIENT_SECRET).props.value, "right-secret");
  assert.equal(panel.state().cortiClientSecret, "", "and it is not saved");
  await panel.blur(TENANT);
  await panel.wait(0);
  assert.deepEqual(
    [panel.requests().at(-1).clientSecret, panel.requests().at(-1).tenant],
    ["right-secret", "acme"]
  );
  await panel.answer({ success: true });
  assert.equal(panel.state().cortiClientSecret, "right-secret", "a passing check saves both");
  assert.equal(panel.state().cortiTenant, "acme");
});

test("Corti: emptying the client ID to retype it keeps the typed secret", async (t) => {
  const panel = await mount(t, {
    overrides: { selectedCloudProvider: "corti", selectedCloudModel: "corti-transcribe" },
    secrets: { cortiClientId: "wrong-id", cortiClientSecret: "", cortiEnvironment: "eu" },
  });
  await panel.type(CLIENT_SECRET, "right-secret");
  await panel.blur(CLIENT_SECRET);
  await panel.wait(0);
  await panel.answer(REJECTED); // the ID is the wrong half
  for (const id of ["wrong-i", "w", ""]) {
    await panel.type(CLIENT_ID, id);
    await panel.wait(500); // a part-typed ID is checked, but never answered here
  }
  assert.equal(panel.field(CLIENT_SECRET).props.value, "right-secret");
  assert.equal(panel.state().cortiClientSecret, "", "the refused secret is not saved");
  await panel.type(CLIENT_ID, "right-id");
  await panel.blur(CLIENT_ID);
  await panel.wait(0);
  assert.deepEqual(
    [panel.requests().at(-1).clientId, panel.requests().at(-1).clientSecret],
    ["right-id", "right-secret"]
  );
  await panel.answer({ success: true });
  assert.equal(panel.state().cortiClientSecret, "right-secret");
});

test("Corti: a secret and the ID it was checked with are saved together", async (t) => {
  const panel = await mount(t, {
    overrides: { selectedCloudProvider: "corti", selectedCloudModel: "corti-transcribe" },
    secrets: { cortiClientId: "id", cortiClientSecret: "good", cortiEnvironment: "eu" },
  });
  await panel.wait(0);
  await panel.answer({ success: true });
  await panel.type(CLIENT_SECRET, "bad");
  await panel.blur(CLIENT_SECRET);
  await panel.wait(0);
  await panel.answer(REJECTED);
  await panel.type(CLIENT_ID, "id2"); // still in the field
  await panel.wait(500);
  await panel.answer({ success: false, errorCode: "network", unverified: true });
  assert.deepEqual(
    [panel.state().cortiClientId, panel.state().cortiClientSecret],
    ["id2", "bad"],
    "never the refused pair (id, bad)"
  );
});

for (const [field, typo, key] of [
  [CLIENT_ID, "good-idd", "cortiClientId"],
  [TENANT, "acm", "cortiTenant"],
]) {
  test(`Corti: a refused ${key} typed over a saved setup is never saved`, async (t) => {
    const saved = {
      cortiClientId: "good-id",
      cortiClientSecret: "good-secret",
      cortiTenant: "acme",
    };
    const panel = await mount(t, {
      overrides: { selectedCloudProvider: "corti", selectedCloudModel: "corti-transcribe" },
      secrets: { ...saved, cortiEnvironment: "eu" },
    });
    await panel.wait(0);
    await panel.answer({ success: true });
    await panel.type(field, typo);
    await panel.blur(field);
    await panel.wait(0);
    await panel.answer(REJECTED); // the secret is as saved, so the typo takes the blame
    assert.equal(panel.state()[key], saved[key]);
    assert.equal(panel.field(field).props.value, typo);
    await panel.unmount();
    assert.equal(panel.state()[key], saved[key], "nor when Settings closes");
  });
}

const CORTI_SAVED = { cortiClientId: "good-id", cortiClientSecret: "good-secret", cortiTenant: "" };
const mountCorti = (t) =>
  mount(t, {
    overrides: { selectedCloudProvider: "corti", selectedCloudModel: "corti-transcribe" },
    secrets: { ...CORTI_SAVED, cortiEnvironment: "eu" },
  });
const cortiPair = (panel) => [panel.state().cortiClientId, panel.state().cortiClientSecret];

test("Corti: a new secret after a refused ID is saved with that ID", async (t) => {
  const panel = await mountCorti(t);
  await panel.wait(0);
  await panel.answer({ success: true });
  await panel.type(CLIENT_ID, "id-right");
  await panel.blur(CLIENT_ID);
  await panel.wait(0);
  await panel.answer(REJECTED);
  await panel.type(CLIENT_SECRET, "s2");
  await panel.blur(CLIENT_SECRET);
  await panel.wait(0);
  await panel.answer({ success: false, errorCode: "network", unverified: true });
  assert.deepEqual(cortiPair(panel), ["id-right", "s2"]);
});

test("Corti: closing Settings while a refused ID waits keeps the working setup", async (t) => {
  const panel = await mountCorti(t);
  await panel.wait(0);
  await panel.answer({ success: true });
  await panel.type(CLIENT_ID, "id-right");
  await panel.blur(CLIENT_ID);
  await panel.wait(0);
  await panel.answer(REJECTED);
  await panel.type(CLIENT_SECRET, "s2");
  await panel.unmount(); // before the new pair is answered
  assert.deepEqual(cortiPair(panel), ["good-id", "good-secret"]);
});

test("Corti: a refused ID typo is held back whatever the secret field holds", async (t) => {
  const panel = await mountCorti(t);
  await panel.wait(0);
  await panel.answer({ success: true });
  await panel.type(CLIENT_SECRET, "new-secret");
  await panel.blur(CLIENT_SECRET);
  await panel.wait(0);
  await panel.answer(REJECTED); // the new secret belongs to a new ID
  await panel.type(CLIENT_SECRET, "good-secret"); // and back to the saved one
  await panel.type(CLIENT_ID, "good-idd");
  await panel.blur(CLIENT_ID);
  await panel.wait(0);
  await panel.answer(REJECTED);
  await panel.unmount();
  assert.deepEqual(cortiPair(panel), ["good-id", "good-secret"]);
});

test("Corti: a refused setup stays held back after its panel is hidden", async (t) => {
  const panel = await mountCorti(t);
  await panel.wait(0);
  await panel.answer({ success: true });
  await panel.type(CLIENT_ID, "id-right");
  await panel.blur(CLIENT_ID);
  await panel.wait(0);
  await panel.answer(REJECTED);
  await panel.type(CLIENT_SECRET, "s2");
  await panel.blur(CLIENT_SECRET);
  await panel.setVisible(false); // the Note Recording tab, before the new pair is answered
  await panel.unmount();
  assert.deepEqual(cortiPair(panel), ["good-id", "good-secret"]);
});

test("Corti: leaving a field that was already saved lets no answer save one still typed", async (t) => {
  const panel = await mount(t, {
    overrides: { selectedCloudProvider: "corti", selectedCloudModel: "corti-transcribe" },
    secrets: {
      cortiClientId: "id0",
      cortiClientSecret: "s0",
      cortiEnvironment: "eu",
      cortiTenant: "",
    },
  });
  await panel.wait(0);
  await panel.answer({ success: true });
  await panel.type(CLIENT_ID, "id1");
  await panel.wait(500);
  await panel.answer({ success: true }); // saves the ID while its field has focus
  await panel.type(TENANT, "ac"); // leaving the ID marks nothing: it has no draft
  await panel.wait(500);
  await panel.answer({ success: false, errorCode: "network", unverified: true });
  assert.equal(panel.state().cortiTenant, "", "a half-typed tenant waits until it is left");
});

function localPicker(
  t,
  { policy, whisper = [], parakeet = [], capability = { supported: true }, overrides }
) {
  const list = (ids) => async () => ({
    success: true,
    models: ids.map((model) => ({ model, downloaded: true })),
  });
  return mount(t, {
    policy,
    overrides: { mode: "local", useLocalWhisper: true, ...overrides },
    electronAPI: {
      ...DOWNLOADS,
      modelGetActiveDownloads: async () => [],
      checkParakeetInstallation: async () => capability,
      listWhisperModels: list(whisper),
      listParakeetModels: list(parakeet),
    },
  });
}
const managedTranscription = (transcription) => ({
  status: "managed",
  appVersion: "1.11.1",
  policy: managedPolicy({ transcription }),
});
const managedSpeech = (allowedLocalModels) =>
  managedTranscription({ allowedModes: ["local", "providers"], allowedLocalModels });
const localTabs = (panel) => panel.find((node) => node.props?.selectedId !== undefined)[0];
const tabIds = (panel) => localTabs(panel).props.providers.map((tab) => tab.id);

test("a restricted member sees only families with an approved or installed model", async (t) => {
  const panel = await localPicker(t, {
    policy: managedSpeech(["base"]),
    parakeet: ["parakeet-tdt-0.6b-v3"],
    overrides: { selectedLocalProvider: "whisper", selectedLocalModel: "base" },
  });
  assert.deepEqual(tabIds(panel), ["whisper", "nvidia"]);
  await panel.selectTab("nvidia");
  assert.equal(localTabs(panel).props.selectedId, "nvidia", "the blocked model can be deleted");
  const card = panel.find((node) => node.props?.modelId === "parakeet-tdt-0.6b-v3")[0];
  assert.equal(card.props.policyBlocked, true);
});

test("a saved family with nothing approved opens on an approved tab without saving", async (t) => {
  const selected = [];
  const panel = await localPicker(t, {
    policy: managedSpeech(["base"]),
    overrides: {
      selectedLocalProvider: "nvidia",
      selectedLocalModel: "orukeet-v0.1.0",
      onLocalProviderSelect: (id) => selected.push(id),
      onLocalModelSelect: (id) => selected.push(id),
    },
  });
  assert.deepEqual(tabIds(panel), ["whisper"]);
  assert.equal(localTabs(panel).props.selectedId, "whisper");
  assert.deepEqual(selected, []);
});

for (const transcriptionContext of ["meeting", "upload"]) {
  test(`the ${transcriptionContext} picker filters its tabs the same way`, async (t) => {
    const panel = await localPicker(t, {
      policy: managedSpeech(["orukeet-v0.1.0"]),
      overrides: { transcriptionContext, selectedLocalProvider: "whisper", selectedLocalModel: "" },
    });
    assert.deepEqual(tabIds(panel), ["oruk"]);
    assert.equal(localTabs(panel).props.selectedId, "oruk");
  });
}

test("a guest keeps every tab", async (t) => {
  const panel = await localPicker(t, {
    overrides: { selectedLocalProvider: "whisper", selectedLocalModel: "" },
  });
  assert.deepEqual(tabIds(panel), ["oruk", "whisper", "nvidia", "cohere"]);
});

test("an unsupported Mac reroutes a blank sherpa selection to Whisper", async (t) => {
  const selected = [];
  await localPicker(t, {
    capability: { supported: false, minimumMacOSVersion: "15.5" },
    overrides: {
      selectedLocalProvider: "nvidia",
      selectedLocalModel: "",
      onLocalProviderSelect: (id) => selected.push(id),
    },
  });
  assert.equal(selected[0], "whisper");
});

test("an unsupported Mac leaves a policy-blocked sherpa selection saved", async (t) => {
  const selected = [];
  await localPicker(t, {
    policy: managedSpeech(["base"]),
    capability: { supported: false, minimumMacOSVersion: "15.5" },
    overrides: {
      selectedLocalProvider: "nvidia",
      selectedLocalModel: "parakeet-tdt-0.6b-v3",
      onLocalProviderSelect: (id) => selected.push(id),
    },
  });
  assert.deepEqual(selected, []);
});

// Settings mounts the Dictation, Note Recording and Upload pickers at once, so a picker
// that saved its own correction rewrote a tab nobody opened (#3100). Note Recording and
// Upload save nothing until a model is picked: a blank provider runs on dictation's, and
// one the tab can't use is named rather than replaced.
const dictating = (provider, model, extra = {}) => ({
  // Latched, or loading the store copies dictation's provider into Note Recording.
  meetingFollowsTranscription: "false",
  meetingFollowsReasoning: "false",
  isSignedIn: "false",
  transcriptionMode: "providers",
  cloudTranscriptionMode: "byok",
  cloudTranscriptionProvider: provider,
  cloudTranscriptionModel: model,
  ...extra,
});
async function scopePicker(t, context, { provider = "", model = "", ...options } = {}) {
  const saves = [];
  const panel = await mount(t, {
    ...options,
    overrides: {
      transcriptionContext: context,
      streamingOnly: context === "meeting",
      selectedCloudProvider: provider,
      selectedCloudModel: model,
      onCloudProviderSelect: (value) => saves.push(["provider", value]),
      onCloudModelSelect: (value) => saves.push(["model", value]),
    },
  });
  await panel.wait(0);
  return { panel, saves };
}
const savedPair = (panel, context) => [
  panel.state()[`${context}CloudTranscriptionProvider`],
  panel.state()[`${context}CloudTranscriptionModel`],
];
const shownTab = (panel) =>
  panel.find((node) => Array.isArray(node.props?.providers) && node.props.selectedId)[0].props
    .selectedId;
const shownModel = (panel) =>
  panel.find((node) => typeof node.props?.onModelSelect === "function")[0].props.selectedModel;
// The harness's `t` returns the key followed by its interpolation values.
const unavailableNotice = (panel) =>
  panel.find(
    (node) =>
      typeof node.props?.children === "string" &&
      node.props.children.startsWith("transcription.providerUnavailable")
  )[0]?.props.children;

test("a blank Note Recording provider shows dictation's and saves nothing, even hidden", async (t) => {
  for (const visible of [false, true]) {
    await t.test(visible ? "shown" : "hidden", async (t) => {
      const { panel, saves } = await scopePicker(t, "meeting", {
        settings: dictating("deepgram", "nova-3"),
        visible,
      });
      assert.deepEqual(saves, []);
      assert.deepEqual(savedPair(panel, "meeting"), ["", ""]);
      assert.equal(shownTab(panel), "deepgram");
      assert.equal(shownModel(panel), "nova-3", "what runs is what is selected");
      assert.equal(unavailableNotice(panel), undefined);
    });
  }
});

test("a blank Upload provider shows what uploads run on and saves nothing", async (t) => {
  await t.test("dictation's provider", async (t) => {
    const { panel, saves } = await scopePicker(t, "upload", {
      settings: dictating("groq", "whisper-large-v3-turbo"),
    });
    assert.deepEqual(saves, []);
    assert.deepEqual(savedPair(panel, "upload"), ["", ""]);
    assert.equal(shownTab(panel), "groq");
    assert.equal(shownModel(panel), "whisper-large-v3-turbo");
  });
  await t.test("dictation's own server stays the upload server", async (t) => {
    const { panel, saves } = await scopePicker(t, "upload", {
      settings: dictating("custom", "my-whisper", {
        cloudTranscriptionBaseUrl: "https://stt.example.test/v1",
      }),
    });
    assert.deepEqual(saves, []);
    assert.deepEqual(savedPair(panel, "upload"), ["", ""]);
    assert.equal(shownTab(panel), "custom");
    assert.equal(panel.field(MODEL).props.value, "my-whisper");
  });
  await t.test("a live-only dictation provider leaves uploads on OpenAI", async (t) => {
    const { panel, saves } = await scopePicker(t, "upload", {
      settings: dictating("deepgram", "nova-3"),
    });
    assert.deepEqual(saves, []);
    assert.equal(shownTab(panel), "openai");
    assert.equal(shownModel(panel), "gpt-transcribe");
    assert.equal(unavailableNotice(panel), undefined);
  });
});

test("a provider the tab can't use is named, not replaced", async (t) => {
  await t.test("Note Recording set to Groq by onboarding", async (t) => {
    const { panel, saves } = await scopePicker(t, "meeting", {
      provider: "groq",
      model: "whisper-large-v3-turbo",
      settings: dictating("groq", "whisper-large-v3-turbo", {
        meetingCloudTranscriptionProvider: "groq",
        meetingCloudTranscriptionModel: "whisper-large-v3-turbo",
      }),
    });
    assert.deepEqual(saves, []);
    assert.deepEqual(savedPair(panel, "meeting"), ["groq", "whisper-large-v3-turbo"]);
    assert.equal(shownTab(panel), "openai");
    assert.equal(shownModel(panel), "", "nothing is selected while Groq is saved");
    assert.equal(unavailableNotice(panel), 'transcription.providerUnavailable {"provider":"Groq"}');

    await panel.selectTab("deepgram");
    assert.equal(unavailableNotice(panel), undefined, "a browsed tab is the user's own choice");
  });
  await t.test("blank Note Recording under a dictation provider it can't use", async (t) => {
    const { panel, saves } = await scopePicker(t, "meeting", {
      settings: dictating("groq", "whisper-large-v3-turbo"),
    });
    assert.deepEqual(saves, []);
    assert.equal(unavailableNotice(panel), 'transcription.providerUnavailable {"provider":"Groq"}');
  });
  await t.test("Upload set to a live-only provider", async (t) => {
    const { panel, saves } = await scopePicker(t, "upload", {
      provider: "deepgram",
      model: "nova-3",
      settings: dictating("deepgram", "nova-3", {
        uploadCloudTranscriptionProvider: "deepgram",
        uploadCloudTranscriptionModel: "nova-3",
      }),
    });
    assert.deepEqual(saves, []);
    assert.equal(shownModel(panel), "");
    assert.equal(
      unavailableNotice(panel),
      'transcription.providerUnavailable {"provider":"Deepgram"}'
    );
  });
  for (const context of ["meeting", "upload"]) {
    await t.test(`${context} left on OpenWhispr Cloud by onboarding`, async (t) => {
      const { panel, saves } = await scopePicker(t, context, {
        provider: "openwhispr",
        settings: dictating("groq", "whisper-large-v3-turbo", {
          [`${context}CloudTranscriptionProvider`]: "openwhispr",
        }),
      });
      assert.deepEqual(saves, []);
      assert.deepEqual(savedPair(panel, context), ["openwhispr", ""]);
      assert.equal(
        unavailableNotice(panel),
        'transcription.providerUnavailable {"provider":"settingsPage.transcription.modes.openwhispr"}'
      );
    });
  }
});

test("picking a model on an inherited tab saves the provider with it", async (t) => {
  const { panel, saves } = await scopePicker(t, "meeting", {
    settings: dictating("deepgram", "nova-3"),
  });
  await panel.selectModel("nova-3");
  assert.equal(panel.state().meetingCloudTranscriptionProvider, "deepgram");
  assert.deepEqual(saves, [["model", "nova-3"]]);
});

test("a managed policy shows the provider it runs for a blank Note Recording one", async (t) => {
  const { panel, saves } = await scopePicker(t, "meeting", {
    settings: dictating("groq", "whisper-large-v3-turbo", { isSignedIn: "true" }),
    policy: managedTranscription({
      allowedModes: ["providers"],
      allowedByokProviders: ["deepgram"],
    }),
  });
  assert.deepEqual(saves, []);
  assert.equal(shownTab(panel), "deepgram");
  assert.equal(shownModel(panel), "nova-3");
  assert.equal(unavailableNotice(panel), undefined);
});

// The harness's `t` returns the key followed by its interpolation values.
const HINT_KEYS = [
  "transcription.browsedProviderHint",
  "transcription.browsedCustomHint",
  "transcription.customInUseHint",
];
const hint = (panel) =>
  panel.find(
    (node) =>
      typeof node.props?.children === "string" &&
      HINT_KEYS.some((key) => node.props.children.startsWith(key))
  )[0]?.props.children;
const managedProviders = (allowedByokProviders) =>
  managedTranscription({ allowedModes: ["providers"], allowedByokProviders });

test("a browsed tab says the saved provider stays in use until a model is picked", async (t) => {
  const panel = await mount(t, {
    settings: {
      meetingCloudTranscriptionProvider: "openai",
      meetingCloudTranscriptionModel: "gpt-4o-mini-transcribe",
    },
    overrides: {
      transcriptionContext: "meeting",
      streamingOnly: true,
      selectedCloudProvider: "openai",
      selectedCloudModel: "gpt-4o-mini-transcribe",
    },
  });
  assert.equal(hint(panel), undefined, "the saved provider's own tab needs no hint");

  await panel.selectTab("deepgram");
  assert.equal(
    hint(panel),
    'transcription.browsedProviderHint {"current":"OpenAI","provider":"Deepgram"}'
  );
  assert.equal(panel.state().meetingCloudTranscriptionProvider, "openai", "browsing saves nothing");

  await panel.selectTab("openai");
  assert.equal(hint(panel), undefined, "browsing back to the saved tab clears it");

  await panel.selectTab("deepgram");
  await panel.selectModel("nova-3");
  assert.equal(panel.state().meetingCloudTranscriptionProvider, "deepgram");
  await panel.setProps({ selectedCloudProvider: "deepgram", selectedCloudModel: "nova-3" });
  assert.equal(hint(panel), undefined, "a picked model saves the tab");
});

test("under a managed policy, the line names the provider the policy runs", async (t) => {
  // OpenAI stays saved, but the policy refuses it and runs Groq, the first one it allows.
  const panel = await mount(t, {
    policy: managedProviders(["groq", "deepgram"]),
    settings: { transcriptionMode: "providers" },
    overrides: { selectedCloudProvider: "openai", selectedCloudModel: "gpt-4o-mini-transcribe" },
  });
  await panel.selectTab("deepgram");
  assert.equal(
    hint(panel),
    'transcription.browsedProviderHint {"current":"Groq","provider":"Deepgram"}'
  );
  await panel.selectTab("groq");
  assert.equal(hint(panel), undefined, "Groq is already in use");
});

test("a blank Note Recording provider names the dictation provider it runs on", async (t) => {
  // Note Recording was never set, so it runs on dictation's Deepgram while the picker
  // shows its first tab; a managed policy leaves that unsaved. The latched flag keeps
  // the store's load from copying dictation's provider in.
  const panel = await mount(t, {
    policy: managedProviders(["openai", "deepgram"]),
    settings: {
      meetingFollowsTranscription: "false",
      meetingTranscriptionMode: "providers",
      cloudTranscriptionProvider: "deepgram",
      cloudTranscriptionModel: "nova-3",
    },
    overrides: {
      transcriptionContext: "meeting",
      streamingOnly: true,
      selectedCloudProvider: "",
      selectedCloudModel: "",
    },
  });
  assert.equal(panel.state().meetingCloudTranscriptionProvider, "");
  await panel.selectTab("openai");
  assert.equal(
    hint(panel),
    'transcription.browsedProviderHint {"current":"Deepgram","provider":"OpenAI"}'
  );
  await panel.selectTab("deepgram");
  assert.equal(hint(panel), undefined, "Deepgram is already in use");
});

test("Dictation Settings keeps a working inherited Note Recording route when selecting Scribe", async (t) => {
  // Legacy BYOK users could keep the default OpenAI provider without writing a provider key.
  const panel = await mount(t, {
    settings: { _providerSettingsMigrated: "", cloudTranscriptionMode: "byok" },
    overrides: { selectedCloudProvider: "openai", selectedCloudModel: "gpt-4o-mini-transcribe" },
  });
  await panel.setProps({ onCloudModelSelect: panel.state().setCloudTranscriptionModel });
  const { selectResolvedMeetingTranscription } = await panel.vite.ssrLoadModule(
    "/stores/settingsStore.ts"
  );
  const { getMeetingStreamingTranscriptionProviders } = await panel.vite.ssrLoadModule(
    "/models/ModelRegistry.ts"
  );
  const { resolveMeetingTranscriptionOptions } =
    await import("../../src/helpers/meetingTranscriptionRouting.js");
  const recording = () => {
    const meeting = selectResolvedMeetingTranscription(panel.state());
    return resolveMeetingTranscriptionOptions({
      transcriptionMode: meeting.transcriptionMode,
      selectedProvider: meeting.cloudTranscriptionProvider,
      selectedModel: meeting.cloudTranscriptionModel,
      byokProviders: getMeetingStreamingTranscriptionProviders(),
    });
  };

  assert.equal(recording().provider, "openai-realtime");
  await panel.selectTab("deepgram");
  await panel.selectModel("nova-3");
  assert.equal(panel.state().meetingCloudTranscriptionProvider, "");
  assert.equal(panel.state().meetingCloudTranscriptionModel, "");
  const deepgramRecording = recording();
  assert.equal(deepgramRecording.provider, "deepgram-realtime");
  assert.equal(deepgramRecording.model, "nova-3");

  await panel.setProps({ selectedCloudProvider: "deepgram", selectedCloudModel: "nova-3" });
  await panel.selectTab("elevenlabs");
  await panel.selectModel("scribe_v2");
  assert.equal(panel.state().cloudTranscriptionProvider, "elevenlabs");
  assert.equal(panel.state().cloudTranscriptionModel, "scribe_v2");
  assert.deepEqual(recording(), deepgramRecording);
  assert.equal(localStorage.getItem("meetingCloudTranscriptionProvider"), "deepgram");
  assert.equal(localStorage.getItem("meetingCloudTranscriptionModel"), "nova-3");
});

test("a browsed Custom tab asks for a model name while the saved provider runs", async (t) => {
  const panel = await mount(t, {
    overrides: { selectedCloudProvider: "openai", selectedCloudModel: "gpt-4o-mini-transcribe" },
  });
  await panel.selectTab("custom");
  assert.equal(hint(panel), 'transcription.browsedCustomHint {"current":"OpenAI"}');
});

test("a custom endpoint in use is named as one", async (t) => {
  const endpoint = "https://stt.example.com/v1";
  const panel = await mount(t, {
    settings: {
      cloudTranscriptionProvider: "custom",
      cloudTranscriptionModel: "whisper-1",
      cloudTranscriptionBaseUrl: endpoint,
    },
    overrides: {
      selectedCloudProvider: "custom",
      selectedCloudModel: "whisper-1",
      cloudTranscriptionBaseUrl: endpoint,
    },
  });
  await panel.selectTab("openai");
  assert.equal(hint(panel), 'transcription.customInUseHint {"provider":"OpenAI"}');
});

test("ElevenLabs shows the dictionary surcharge on dictation and Note Recording", async (t) => {
  const panel = await mount(t, {
    overrides: { selectedCloudProvider: "elevenlabs", selectedCloudModel: "scribe_v3" },
  });
  const notices = () =>
    panel.find((node) => node.props?.children === "transcription.elevenlabs.keytermsNote");
  assert.equal(notices().length, 1);
  await panel.setProps({
    transcriptionContext: "meeting",
    streamingOnly: true,
    selectedCloudModel: "scribe_v3_live",
  });
  assert.equal(notices().length, 1);
  await panel.setProps({
    transcriptionContext: "upload",
    streamingOnly: false,
    selectedCloudModel: "scribe_v3",
  });
  assert.equal(notices().length, 0);
});

test("AssemblyAI Dictation needs LLM approval to appear or save, while realtime stays selectable", async (t) => {
  const selected = [];
  const panel = await mount(t, {
    policy: assemblyAiPolicy(true, true),
    overrides: {
      selectedCloudProvider: "assemblyai",
      selectedCloudModel: "dictation",
      onCloudModelSelect: (id) => selected.push(id),
    },
  });
  await require("react").act(() => loadAssemblyAiDictationCatalog(panel.vite));
  const list = () => panel.find((node) => typeof node.props?.onModelSelect === "function")[0].props;
  const ids = () => list().models.map((model) => model.value);
  assert.ok(ids().includes("dictation"));
  const staleSelect = list().onModelSelect;
  await panel.selectModel("dictation");
  await panel.setPolicy(assemblyAiPolicy(true, false));
  assert.ok(!ids().includes("dictation"));
  staleSelect("dictation");
  assert.ok(ids().includes("universal-3-6-pro"));
  await panel.selectModel("universal-3-6-pro");
  await panel.setPolicy(assemblyAiPolicy(false, true));
  staleSelect("dictation");
  await panel.setPolicy(assemblyAiPolicy(true, true));
  await require("react").act(() => setManagedBedrockCleanup(panel.vite));
  assert.ok(!ids().includes("dictation"));
  staleSelect("dictation");
  await panel.selectModel("universal-3-6-pro");
  assert.deepEqual(selected, ["dictation", "universal-3-6-pro", "universal-3-6-pro"]);
});

test("the dictation picker explains the current cleanup setting only for selected AssemblyAI batch dictation", async (t) => {
  const panel = await mount(t, {
    overrides: { selectedCloudProvider: "assemblyai", selectedCloudModel: "dictation" },
    secrets: {
      transcriptionMode: "providers",
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      cloudTranscriptionProvider: "assemblyai",
      cloudTranscriptionModel: "dictation",
      useCleanupModel: true,
    },
  });
  await require("react").act(() => loadAssemblyAiDictationCatalog(panel.vite));
  const hint = () =>
    panel.find(
      (n) =>
        typeof n.props?.children === "string" &&
        n.props.children.startsWith("settingsPage.aiModels.assemblyAiCleanup.picker")
    )[0]?.props.children;
  assert.equal(hint(), "settingsPage.aiModels.assemblyAiCleanup.pickerOn");
  await panel.setStore({ useCleanupModel: false });
  assert.equal(hint(), "settingsPage.aiModels.assemblyAiCleanup.pickerOff");
  await panel.selectTab("openai");
  assert.equal(hint(), undefined);
  await panel.selectTab("assemblyai");
  await panel.setProps({ transcriptionContext: "upload" });
  assert.equal(hint(), undefined);
});
