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

test("the tray menu leads with the dictation pill's quick actions", () => {
  const calls = [];
  const trayManager = new TrayManager();
  trayManager.windowManager = {
    isDictationPanelVisible: () => false,
    sendStartDictation: () => calls.push("dictation"),
    sendOpenAssistantPanel: () => calls.push("assistant"),
    startManualMeeting: async () => calls.push("meeting"),
  };

  const [listen, assistant, meeting, separator] = trayManager.buildContextMenuTemplate();

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
  assert.deepEqual(calls, ["dictation", "assistant", "meeting"]);
});
