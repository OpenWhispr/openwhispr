const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { mountSettingsPageOwner } = require("../lib/settingsPageOwnerHarness");

const prefix = "settingsPage.developer.removeModels.";

function buttonIn(node, text) {
  const button = [...node.querySelectorAll("button")].find(
    (entry) => entry.textContent.trim() === text
  );
  assert.ok(button, `Missing button ${text}: ${node.textContent}`);
  return button;
}

function seedSelections(store) {
  store.setState({
    cleanupMode: "local",
    cleanupModel: "surviving-local",
    dictationAgentMode: "local",
    dictationAgentModel: "deleted-local",
    noteFormattingMode: "local",
    noteFormattingModel: "not-downloaded",
    chatAgentMode: "providers",
    chatAgentModel: "remote-model",
  });
}

function selections(store) {
  const { cleanupModel, dictationAgentModel, noteFormattingModel, chatAgentModel } =
    store.getState();
  return { cleanupModel, dictationAgentModel, noteFormattingModel, chatAgentModel };
}

test("SettingsPage System reconciles a partial model wipe and clears local selections only on complete success", async (t) => {
  const { dom, container, render, store, navigation, SettingsPage } =
    await mountSettingsPageOwner(t);
  const api = dom.electronAPI;
  api.deleteAllWhisperModels = async () => ({ success: true });
  api.deleteAllParakeetModels = async () => ({ success: true });
  api.modelDeleteAll = async () => ({ success: false });
  api.modelGetAll = async () => [
    { id: "surviving-local", isDownloaded: true },
    { id: "not-downloaded", isDownloaded: false },
  ];
  seedSelections(store);
  await render(React.createElement(SettingsPage, { navigation }));

  const confirmRemoval = async () => {
    await React.act(async () => buttonIn(container, "settingsPage.developer.clearCache").click());
    const dialog = dom.document.querySelector('[role="dialog"][data-state="open"]');
    await React.act(async () => buttonIn(dialog, prefix + "confirmText").click());
  };

  await confirmRemoval();
  assert.deepEqual(selections(store), {
    cleanupModel: "surviving-local",
    dictationAgentModel: "",
    noteFormattingModel: "",
    chatAgentModel: "remote-model",
  });
  const failure = dom.document.querySelector('[role="dialog"][data-state="open"]');
  assert.ok(failure.textContent.includes(prefix + "failedTitle"));
  assert.equal(dom.document.body.textContent.includes(prefix + "successTitle"), false);
  await React.act(async () => buttonIn(failure, "OK").click());

  seedSelections(store);
  api.modelDeleteAll = async () => ({ success: true });
  await confirmRemoval();
  assert.deepEqual(selections(store), {
    cleanupModel: "",
    dictationAgentModel: "",
    noteFormattingModel: "",
    chatAgentModel: "remote-model",
  });
  const success = dom.document.querySelector('[role="dialog"][data-state="open"]');
  assert.ok(success.textContent.includes(prefix + "successTitle"));
});
