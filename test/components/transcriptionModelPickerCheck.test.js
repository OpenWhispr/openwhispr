const assert = require("node:assert/strict");
const test = require("node:test");
const { mountSettingsPanel } = require("../lib/settingsPanelHarness");

const PICKER = "/components/TranscriptionModelPicker.tsx";
const KEY = "common.apiKey";
const ENDPOINT = "transcription.endpointUrl";
const CUSTOM_KEY = "transcription.apiKeyOptional";
const MODEL = "common.model";
const CLIENT_ID = "transcription.corti.clientId";
const CLIENT_SECRET = "transcription.corti.clientSecret";
const TENANT = "transcription.corti.tenant";
const KEYLESS_REFUSAL = { success: false, errorCode: "credentialsRejected", status: 401 };
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
  await panel.answer(KEYLESS_REFUSAL);
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
