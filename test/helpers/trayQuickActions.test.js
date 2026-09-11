const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function loadTrayWithStubs(request, parent, isMain) {
  if (request === "electron") return { Tray: class {}, Menu: {}, nativeImage: {}, app: {} };
  if (request === "./debugLogger") return { info: () => undefined, debug: () => undefined };
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  return originalLoad.call(this, request, parent, isMain);
};
const TrayManager = require("../../src/helpers/tray");
Module._load = originalLoad;

function createTrayManager(calls, { dictating = false } = {}) {
  const trayManager = new TrayManager();
  trayManager.windowManager = {
    isDictationPanelVisible: () => false,
    isDictating: () => dictating,
    sendStartListening: () => calls.push("start-listening"),
    sendStopDictation: () => calls.push("stop-dictation"),
    sendOpenAssistantPanel: () => calls.push("assistant"),
    sendStartMeeting: () => calls.push("meeting"),
  };
  return trayManager;
}

test("the tray menu leads with the dictation pill's quick actions", () => {
  const calls = [];
  const [listen, assistant, meeting, separator] =
    createTrayManager(calls).buildContextMenuTemplate();

  assert.deepEqual(
    [listen.label, assistant.label, meeting.label, separator.type],
    [
      "app.commandMenu.startListening",
      "app.commandMenu.askAssistant",
      "app.commandMenu.startMeetingRecording",
      "separator",
    ]
  );

  listen.click();
  assistant.click();
  meeting.click();
  // All three go through the window manager's tray entries, which either ask the
  // renderer or explain a refusal rather than swallowing the click.
  assert.deepEqual(calls, ["start-listening", "assistant", "meeting"]);
});

test("the tray's listen item stops the recording it reflects", () => {
  const calls = [];
  const [listen] = createTrayManager(calls, { dictating: true }).buildContextMenuTemplate();

  assert.equal(listen.label, "app.commandMenu.stopListening");
  listen.click();
  assert.deepEqual(calls, ["stop-dictation"]);
});
