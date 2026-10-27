const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { mountSettingsPageOwner } = require("../lib/settingsPageOwnerHarness");

test("Tone & Style enables cleanup and targets its tab even after Language Models was opened", async (t) => {
  const { container, render, store, navigation, SettingsPage } = await mountSettingsPageOwner(t, {
    section: "noteFormatting",
  });
  assert.equal(navigation.getState().section, "llms");
  assert.equal(navigation.getState().llmTab, "noteFormatting");
  store.setState({
    toneStyleEnabled: true,
    useCleanupModel: false,
    cleanupMode: "local",
    cleanupProvider: "local",
    cleanupModel: "",
  });
  await render(React.createElement(SettingsPage, { navigation }));
  await React.act(async () => navigation.getState().openSettings("toneStyle"));
  assert.ok(container.textContent.includes("toneStyle.title"));
  const turnOn = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "toneStyle.settings.turnOnCleanup"
  );
  assert.ok(turnOn);
  await React.act(async () => turnOn.click());
  assert.equal(store.getState().useCleanupModel, true);
  assert.equal(navigation.getState().section, "llms");
  assert.equal(navigation.getState().llmTab, "dictationCleanup");
  await React.act(async () => navigation.getState().openSettings("noteFormatting"));
  assert.equal(
    navigation.getState().llmTab,
    "noteFormatting",
    "live error-action alias navigates an already open host"
  );
});
