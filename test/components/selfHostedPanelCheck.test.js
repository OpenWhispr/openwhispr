const assert = require("node:assert/strict");
const test = require("node:test");
const { mountSettingsPanel } = require("../lib/settingsPanelHarness");

const PANEL = "/components/SelfHostedPanel.tsx";
const URL_FIELD = "settingsPage.selfHosted.serverUrl";
const MODEL = "common.model";
const SERVER = "http://192.168.1.20:8178";
const props = (overrides = {}) => ({
  service: "transcription",
  url: "",
  onUrlChange() {},
  model: "",
  onModelChange() {},
  ...overrides,
});
const mount = (t, { overrides, ...options } = {}) =>
  mountSettingsPanel(t, { module: PANEL, props: props(overrides), ...options });

test("the model holds the status, and the address waits until it is left", async (t) => {
  const panel = await mount(t, { overrides: { model: "whisper-large-v3" } });
  assert.ok(panel.field(MODEL).props.check);
  assert.equal(panel.field(MODEL).props.invalidOn, "modelNotFound");
  assert.equal(panel.field(URL_FIELD).props.check, undefined);
  await panel.focus(URL_FIELD);
  await panel.setProps({ url: SERVER });
  await panel.wait(2000);
  await panel.blur(URL_FIELD, { windowSwitch: true });
  await panel.wait(2000);
  assert.equal(panel.requests().length, 0);
  await panel.blur(URL_FIELD);
  await panel.wait(0); // leaving the fields checks at once
  assert.deepEqual(panel.requests(), [
    { scope: "transcription", provider: "custom", baseUrl: SERVER, model: "whisper-large-v3" },
  ]);
});

test("this server takes no key, so a refusal says it wants one", async (t) => {
  const panel = await mount(t, { overrides: { url: SERVER, model: "whisper-large-v3" } });
  await panel.wait(0);
  await panel.answer({ success: false, errorCode: "credentialsRejected", status: 403 });
  assert.equal(panel.field(MODEL).props.failureReason, "reasoning.custom.endpointUnauthorized");
});

test("an incomplete or hidden self-hosted panel sends nothing", async (t) => {
  for (const [name, options] of [
    ["no model", { overrides: { url: SERVER } }],
    ["hidden", { overrides: { url: SERVER, model: "whisper-large-v3" }, visible: false }],
  ]) {
    await t.test(name, async (t) => {
      const panel = await mount(t, options);
      await panel.wait(5000);
      assert.equal(panel.requests().length, 0);
    });
  }
});

test("a self-hosted panel asks again each time it is shown", async (t) => {
  const panel = await mount(t, { overrides: { url: SERVER, model: "whisper-large-v3" } });
  await panel.wait(0);
  await panel.answer({ success: true });
  await panel.setVisible(false);
  assert.equal(panel.phase(), "idle", "nothing is shown while hidden");
  await panel.setVisible(true);
  await panel.wait(0);
  assert.equal(panel.requests().length, 2, "a shown panel asks again");
});

test("a self-hosted server for the streaming Orukeet model is left unchecked", async (t) => {
  const panel = await mount(t, { overrides: { url: SERVER, model: "orukeet-v0.1.0" } });
  await panel.wait(5000);
  assert.equal(panel.requests().length, 0);
  assert.equal(panel.phase(), "idle");
});

test("the address and model save as they are typed", async (t) => {
  const saved = [];
  const panel = await mount(t, {
    overrides: {
      onUrlChange: (value) => saved.push(["url", value]),
      onModelChange: (value) => saved.push(["model", value]),
    },
  });
  await panel.type(URL_FIELD, "http://192.168.1.20 ");
  await panel.type(MODEL, "whisper ");
  assert.deepEqual(saved, [
    ["url", "http://192.168.1.20 "],
    ["model", "whisper "],
  ]);
});
