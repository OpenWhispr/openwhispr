const assert = require("node:assert/strict");
const test = require("node:test");
const { mountSettingsPanel } = require("../lib/settingsPanelHarness");

const PANEL = "/components/OpenAICompatiblePanel.tsx";
const ENDPOINT = "reasoning.custom.endpointTitle";
const OPTIONAL_KEY = "reasoning.custom.apiKeyOptional";
const BASE = "http://127.0.0.1:11434/v1";
const REJECTED = { success: false, errorCode: "credentialsRejected", status: 401 };
const props = (overrides = {}) => ({
  baseUrl: BASE,
  setBaseUrl() {},
  apiKey: "",
  setApiKey() {},
  model: "",
  setModel() {},
  ...overrides,
});
// The panel's own model-list load uses the renderer's fetch.
const respond =
  (status, body = {}) =>
  async () => ({
    ok: status === 200,
    status,
    statusText: "",
    json: async () => body,
    text: async () => "",
  });
const modelList = respond(200, { data: [{ id: "llama-test" }] });
const listError = (panel) =>
  panel.find((node) => node.props?.className === "text-xs text-destructive")[0];
const mount = (t, { overrides, ...options } = {}) =>
  mountSettingsPanel(t, { module: PANEL, props: props(overrides), fetch: modelList, ...options });
// The key setter saves straight into the panel's props, as the store does for its parent.
const savingKey = (saved) => {
  const live = props({
    setApiKey: (value) => {
      saved.push(value);
      live.apiKey = value;
    },
  });
  return live;
};

test("an applied address is checked at once; its field holds the status", async (t) => {
  const panel = await mount(t);
  await panel.wait(0);
  assert.deepEqual(panel.requests(), [
    { scope: "reasoning", provider: "custom", baseUrl: BASE, apiKey: "", model: "" },
  ]);
  assert.ok(panel.field(ENDPOINT).props.check);
  assert.equal(panel.field(OPTIONAL_KEY).props.check, undefined);
  await panel.answer({ success: true });
  assert.equal(panel.field(ENDPOINT).props.check.phase, "connected");
});

test("the panel's model is part of the check, and a new model checks at once", async (t) => {
  const panel = await mount(t, { overrides: { model: "llama-test" } });
  await panel.wait(0);
  assert.equal(panel.requests().at(-1).model, "llama-test");
  await panel.answer({ success: true });
  await panel.setProps({ model: "llama-other" });
  assert.equal(panel.field(ENDPOINT).props.check.phase, "waiting");
  await panel.wait(0); // a model pick is not typing, so nothing waits
  assert.deepEqual(
    panel.requests().map((config) => config.model),
    ["llama-test", "llama-other"]
  );
});

test("a new address waits until the field is left; a window switch applies nothing", async (t) => {
  const applied = [];
  const panel = await mount(t, { overrides: { setBaseUrl: (value) => applied.push(value) } });
  await panel.wait(0);
  await panel.answer({ success: true });
  await panel.type(ENDPOINT, "http://127.0.0.1:8080");
  assert.equal(panel.field(ENDPOINT).props.check.phase, "idle", "the old status leaves");
  await panel.blur(ENDPOINT, { windowSwitch: true });
  await panel.wait(2000);
  assert.deepEqual(applied, []);
  assert.equal(panel.requests().length, 1);
  await panel.blur(ENDPOINT);
  assert.deepEqual(applied, ["http://127.0.0.1:8080"]);
  await panel.setProps({ baseUrl: "http://127.0.0.1:8080" });
  await panel.wait(0); // leaving the field checks at once
  assert.equal(panel.requests().at(-1).baseUrl, "http://127.0.0.1:8080");
});

test("a server that refuses a keyless check says it wants a key", async (t) => {
  const panel = await mount(t);
  await panel.wait(0);
  await panel.answer(REJECTED);
  const unauthorized = "reasoning.custom.endpointUnauthorized";
  assert.equal(panel.field(ENDPOINT).props.failureReason, unauthorized);
  assert.equal(
    panel.field(ENDPOINT).props.invalidOn,
    undefined,
    "no failure proves an address wrong"
  );
  await panel.setProps({ apiKey: "sk-server" });
  await panel.wait(0);
  await panel.answer(REJECTED);
  assert.equal(panel.field(ENDPOINT).props.failureReason, undefined, "with a key, a rejection");
});

test("the list's error line gives way to the check's reason", async (t) => {
  const panel = await mount(t, { fetch: respond(401) });
  await panel.wait(0); // the list loads and the check goes out
  assert.equal(listError(panel), undefined, "nothing twice while the check runs");
  await panel.answer(REJECTED);
  assert.equal(listError(panel), undefined);
  await panel.retry();
  await panel.answer({ success: true });
  assert.ok(listError(panel), "a list that fails behind a passing check still says so");
});

test("an address without http:// or https:// keeps the list's message, unchecked", async (t) => {
  const panel = await mount(t, { overrides: { baseUrl: "localhost:11434/v1" } });
  await panel.wait(1000);
  assert.equal(panel.requests().length, 0);
  assert.equal(listError(panel).props.children, "reasoning.custom.endpointWithProtocol");
});

test("OpenRouter checks its key, which holds the status", async (t) => {
  const panel = await mount(t, {
    overrides: {
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      lockedBaseUrl: true,
      apiKeyRequired: true,
      apiKey: "sk-or-saved",
    },
  });
  assert.equal(panel.field(ENDPOINT), undefined);
  await panel.wait(0);
  assert.deepEqual(
    panel.requests().map((config) => [config.provider, config.apiKey]),
    [["openrouter", "sk-or-saved"]]
  );
  assert.ok(panel.field("common.apiKey").props.check);
  assert.equal(panel.field("common.apiKey").props.invalidOn, "credentialsRejected");
});

test("a hidden server panel sends nothing until it is shown, then asks again", async (t) => {
  const panel = await mount(t, { visible: false });
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

test("a key typed into a failed list waits for its check to settle", async (t) => {
  const saved = [];
  const panel = await mount(t, { fetch: respond(401), props: savingKey(saved) });
  await panel.wait(0); // the list fails without a key; the check goes out
  assert.equal(globalThis.fetch.mock.calls.length, 1);
  await panel.answer(REJECTED);
  for (const key of ["s", "sk"]) await panel.type(OPTIONAL_KEY, key);
  await panel.wait(499);
  assert.equal(globalThis.fetch.mock.calls.length, 1, "the list never sees a half-typed key");
  assert.equal(panel.requests().length, 1, "nor does the check");
  await panel.wait(1);
  assert.equal(panel.requests().at(-1).apiKey, "sk");
  assert.equal(globalThis.fetch.mock.calls.length, 1, "the list waits for the check's answer");
  assert.deepEqual(saved, [], "nor is it saved");
  await panel.answer({ success: true });
  assert.deepEqual(saved, ["sk"], "a passing key saves at once");
  assert.equal(globalThis.fetch.mock.calls.length, 2, "a settled key retries the failed list");
  const [, init] = globalThis.fetch.mock.calls[1].arguments;
  assert.equal(init.headers.Authorization, "Bearer sk");
});

test("a parent's new setter on each render never reloads a failed list", async (t) => {
  const panel = await mount(t, { fetch: respond(401) });
  await panel.wait(0); // the list fails without a key
  await panel.answer(REJECTED);
  for (const key of ["s", "sk"]) {
    await panel.type(OPTIONAL_KEY, key);
    // InferenceConfigEditor passes setField("cloudBaseUrl"), a new function on each render.
    await panel.setProps({ setBaseUrl() {} });
  }
  assert.equal(globalThis.fetch.mock.calls.length, 1, "the list never sees a half-typed key");
});

test("an accepted key supersedes an obsolete in-flight catalog without waiting for it", async (t) => {
  // The first list load answers only when the test says so; later loads answer at once.
  let settle;
  const slow = new Promise((resolve) => {
    settle = resolve;
  });
  const panel = await mount(t, {
    fetch: (...args) => (globalThis.fetch.mock.calls.length > 1 ? modelList(...args) : slow),
    props: savingKey([]),
  });
  await panel.wait(0); // the list is still loading; the check goes out
  await panel.answer(REJECTED);
  await panel.type(OPTIONAL_KEY, "sk-late");
  await panel.wait(500);
  assert.equal(panel.requests().at(-1).apiKey, "sk-late");
  await panel.answer({ success: true });
  assert.equal(globalThis.fetch.mock.calls.length, 2, "the accepted key starts its own catalog");
  assert.equal(globalThis.fetch.mock.calls[0].arguments[1].signal.aborted, true);
  settle(await respond(401)());
  await panel.wait(0);
  assert.equal(globalThis.fetch.mock.calls.length, 2, "the settled list retries with the key");
  const [, init] = globalThis.fetch.mock.calls[1].arguments;
  assert.equal(init.headers.Authorization, "Bearer sk-late");
  await panel.wait(5000);
  assert.equal(globalThis.fetch.mock.calls.length, 2, "once");
});

test("a hidden panel's failed list stays quiet when its key changes elsewhere", async (t) => {
  const panel = await mount(t, { fetch: respond(401), visible: false });
  await panel.wait(0);
  assert.equal(globalThis.fetch.mock.calls.length, 0, "a hidden mount performs no discovery");
  await panel.setProps({ apiKey: "sk-elsewhere" });
  await panel.wait(5000);
  assert.equal(globalThis.fetch.mock.calls.length, 0);
  assert.equal(panel.requests().length, 0);
  await panel.setVisible(true);
  await panel.wait(0);
  assert.equal(globalThis.fetch.mock.calls.length, 1);
  assert.equal(panel.requests().length, 1, "revealing restores checks and discovery");
});

test("a server key saves trimmed once its field is left, and the address is checked again", async (t) => {
  const saved = [];
  const panel = await mount(t, { props: savingKey(saved) });
  await panel.type(OPTIONAL_KEY, " sk-ser");
  await panel.type(OPTIONAL_KEY, " sk-server ");
  await panel.wait(500); // the key still has focus, so the pause runs
  assert.deepEqual(
    panel.requests().map((config) => config.apiKey),
    ["sk-server"]
  );
  assert.deepEqual(saved, [], "nothing is saved while the key is typed");
  await panel.blur(OPTIONAL_KEY);
  assert.deepEqual(saved, [], "a key left while its check runs waits for the answer");
  await panel.answer({ success: false, errorCode: "network", unverified: true });
  assert.deepEqual(saved, ["sk-server"], "leaving the field saves it");
});

test("a key someone's own server refuses still saves once its field is left", async (t) => {
  const saved = [];
  const panel = await mount(t, { props: savingKey(saved) });
  await panel.wait(0);
  await panel.answer({ success: true });
  await panel.type(OPTIONAL_KEY, "sk-wrong");
  await panel.blur(OPTIONAL_KEY);
  await panel.wait(0);
  await panel.answer(REJECTED);
  assert.deepEqual(saved, ["sk-wrong"]);
});

test("a key OpenRouter refuses is never saved", async (t) => {
  const saved = [];
  const live = Object.assign(savingKey(saved), {
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    lockedBaseUrl: true,
    apiKeyRequired: true,
    apiKey: "sk-or-saved",
  });
  const panel = await mount(t, { props: live });
  await panel.wait(0);
  await panel.answer({ success: true });
  await panel.type("common.apiKey", "sk-or-wrong");
  await panel.blur("common.apiKey");
  await panel.wait(0);
  await panel.answer(REJECTED);
  await panel.unmount();
  assert.deepEqual(saved, []);
});
